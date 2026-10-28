<?php
/**
 * ACB mobile-banking client (apiapp.acb.com.vn).
 *
 * The app API changed: login now needs deviceId + apikey headers, transaction history moved to
 * /person/transaction-history/list, and when that service is blocked for an account the
 * notifications feed is used instead.
 *
 * Callers should use the high-level helpers; they cache the access token and log in again
 * (once) when it expires, so a cron that runs every minute does not log in every minute:
 *
 *     $acb = new ACB($username, $password);
 *     $rows = $acb->transactions($accountNo, 100);   // array|null
 *     $bal  = $acb->balance();                        // ['ok'=>bool, 'balance'=>float, 'msg'=>string]
 *
 * Configuration (all optional, .env):
 *     ACB_CLIENT_ID, ACB_API_KEY, ACB_DEVICE_ID, ACB_APP_VERSION   app identity sent to ACB
 *     ACB_PROXY       host:port or host:port:user:pass
 *     ACB_BASE_URL    override https://apiapp.acb.com.vn (tests)
 *     ACB_INSECURE_SSL=1   skip TLS verification (only if a proxy re-signs HTTPS)
 */
class ACB
{
    public $clientId;
    public $deviceId;
    public $apiKey;
    public $appVersion;
    public $username = '';
    public $password = '';
    public $proxy = null;

    /** Last problem seen by the high-level helpers, for logs / admin messages. */
    public $lastError = '';

    private $baseUrl;
    private $token = '';

    private $routes = array(
        'login' => '/mb/v2/auth/tokens',
        'balance' => '/mb/legacy/ss/cs/bankservice/transfers/list/account-payment',
        'history' => '/mb/legacy/ss/cs/person/transaction-history/list',
        'notifications' => '/mb/legacy/ss/cs/bankservice/v2/notifications',
        'recipient' => '/mb/legacy/ss/cs/bankservice/transfers/accounts/%s',
    );

    public function __construct($username = '', $password = '')
    {
        $this->username = (string)$username;
        $this->password = (string)$password;
        $this->clientId = self::env('ACB_CLIENT_ID', 'iuSuHYVufIUuNIREV0FB9EoLn9kHsDbm');
        $this->apiKey = self::env('ACB_API_KEY', 'CQk6S5usauGmMgMYLGqCuDtgtqIM8FI1');
        $this->deviceId = self::env('ACB_DEVICE_ID', 'E80CFFC6-F3CF-4718-B274-97DAFE0BE365');
        $this->appVersion = self::env('ACB_APP_VERSION', '3.50.0');
        $this->baseUrl = rtrim(self::env('ACB_BASE_URL', 'https://apiapp.acb.com.vn'), '/');
        $this->proxy = self::env('ACB_PROXY', null);
    }

    private static function env($key, $default)
    {
        if (class_exists('EnvLoader', false)) {
            $value = EnvLoader::get($key);
            if ($value !== null && $value !== '') {
                return $value;
            }
        }
        $value = getenv($key);
        return ($value !== false && $value !== '') ? $value : $default;
    }

    // ───────────────────────── high-level helpers ─────────────────────────

    /**
     * Normalised transactions of $accountNo (newest first, at most $rows), or null when ACB
     * could not be reached / refused. Each row has transactionNumber, transactionID,
     * description, amount (always >= 0), type (IN|OUT) and postingDate (ms).
     */
    public function transactions($accountNo, $rows = 20)
    {
        $this->lastError = '';
        $rows = max(1, (int)$rows);

        $result = $this->withToken(function ($token) use ($accountNo, $rows) {
            return $this->fetchTransactions($accountNo, $rows, $token);
        });

        if (!is_array($result)) {
            $this->lastError = $this->lastError !== '' ? $this->lastError : 'Không lấy được lịch sử giao dịch từ ACB';
            return null;
        }

        return $result;
    }

    /** Balance of the first payment account: ['ok' => bool, 'balance' => float, 'msg' => string]. */
    public function balance()
    {
        $this->lastError = '';
        $response = $this->withToken(function ($token) {
            return $this->decodeResult($this->get_balance($token));
        }, true);

        if (is_array($response) && isset($response['data'][0]['balance'])) {
            return array('ok' => true, 'balance' => $response['data'][0]['balance'], 'msg' => '');
        }

        $msg = $this->lastError !== '' ? $this->lastError : $this->describeFailure($response);
        return array('ok' => false, 'balance' => null, 'msg' => $msg !== '' ? $msg : 'Không thể kiểm tra số dư');
    }

    /**
     * Runs $call($token) with a cached token. If ACB says the token expired, logs in again
     * once and retries. $call may return null (token expired), or any other value.
     * With $rawResponse the callable returns the decoded API response instead and expiry is
     * detected from it.
     */
    private function withToken($call, $rawResponse = false)
    {
        $token = $this->loadCachedToken();
        $freshLogin = false;

        if ($token === '') {
            $token = $this->loginForToken();
            $freshLogin = true;
            if ($token === '') {
                return null;
            }
        }

        $result = $call($token);
        $expired = $rawResponse ? $this->isTokenExpiredResponse($result) : $result === null;

        if ($expired && !$freshLogin) {
            $this->forgetCachedToken();
            $token = $this->loginForToken();
            if ($token === '') {
                return null;
            }
            $result = $call($token);
            $expired = $rawResponse ? $this->isTokenExpiredResponse($result) : $result === null;
        }

        if ($expired) {
            $this->lastError = $this->lastError !== '' ? $this->lastError : 'Token ACB bị từ chối sau khi đăng nhập lại';
            return null;
        }

        return $result;
    }

    private function loginForToken()
    {
        $response = $this->login_acb($this->username, $this->password);

        if (is_array($response) && !empty($response['accessToken'])) {
            $this->token = trim($response['accessToken']);
            $this->storeCachedToken($this->token);
            return $this->token;
        }

        $detail = is_array($response)
            ? (isset($response['error']) ? $response['error'] : (isset($response['message']) ? $response['message'] : ''))
            : '';
        $this->lastError = 'Đăng nhập ACB thất bại' . ($detail !== '' ? ': ' . $detail : '');
        return '';
    }

    // ───────────────────────── token cache ─────────────────────────
    // One small file per account in the system temp dir (never under the web root).

    private function tokenFile()
    {
        // The password is part of the key (hashed) so changing credentials never reuses an old token.
        $key = sha1($this->username . '|' . $this->password . '|' . $this->deviceId . '|' . $this->baseUrl);
        return rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'acb_token_' . $key . '.json';
    }

    private function loadCachedToken()
    {
        if ($this->token !== '') {
            return $this->token;
        }
        $file = $this->tokenFile();
        if (!is_readable($file)) {
            return '';
        }
        $data = json_decode((string)file_get_contents($file), true);
        return (is_array($data) && !empty($data['token'])) ? (string)$data['token'] : '';
    }

    private function storeCachedToken($token)
    {
        $file = $this->tokenFile();
        if (@file_put_contents($file, json_encode(array('token' => $token, 'time' => time())), LOCK_EX) !== false) {
            @chmod($file, 0600);
        }
    }

    private function forgetCachedToken()
    {
        $this->token = '';
        @unlink($this->tokenFile());
    }

    // ───────────────────────── requests ─────────────────────────

    private function makeRequestId()
    {
        if (function_exists('random_bytes')) {
            try {
                $bytes = random_bytes(16);
                $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
                $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
                $hex = bin2hex($bytes);

                return substr($hex, 0, 8) . '-'
                    . substr($hex, 8, 4) . '-'
                    . substr($hex, 12, 4) . '-'
                    . substr($hex, 16, 4) . '-'
                    . substr($hex, 20, 12);
            } catch (Exception $exception) {
                // fall through to mt_rand
            }
        }

        $segments = array(
            sprintf('%04x%04x', mt_rand(0, 0xffff), mt_rand(0, 0xffff)),
            sprintf('%04x', mt_rand(0, 0xffff)),
            sprintf('%04x', mt_rand(0, 0x0fff) | 0x4000),
            sprintf('%04x', mt_rand(0, 0x3fff) | 0x8000),
            sprintf('%04x%04x%04x', mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)),
        );

        return implode('-', $segments);
    }

    private function endpoint($route, $parameters = array())
    {
        $path = isset($this->routes[$route]) ? $this->routes[$route] : $route;

        if (!empty($parameters)) {
            $path = vsprintf($path, $parameters);
        }

        return $this->baseUrl . $path;
    }

    private function appendQuery($url, $query)
    {
        $queryString = http_build_query($query);
        return $queryString === '' ? $url : $url . '?' . $queryString;
    }

    private function buildHeaders($token = null, $version = null)
    {
        $host = parse_url($this->baseUrl, PHP_URL_HOST);
        $headers = array(
            'Content-Type: application/json; charset=utf-8',
            'Host: ' . ($host ? $host : 'apiapp.acb.com.vn'),
            'User-Agent: ACB-MBA/9 CFNetwork/1399 Darwin/22.1.0',
            'Accept: application/json, text/plain, */*',
            'Accept-Language: vi',
            'Cache-Control: no-cache',
            'apikey: ' . $this->apiKey,
            'x-app-version: ' . ($version !== null ? $version : $this->appVersion),
            'x-device-id: ' . $this->deviceId,
            'x-conversation-id: ' . $this->makeRequestId() . '-1-',
            'x-request-id: ' . $this->makeRequestId(),
        );

        if ($token !== null && $token !== '') {
            $headers[] = 'Authorization: bearer ' . $token;
        }

        return $headers;
    }

    private function encodeResult($value)
    {
        return json_encode($value);
    }

    private function decodeResult($value)
    {
        if (is_array($value)) {
            return $value;
        }

        $decoded = json_decode((string)$value, true);
        return is_array($decoded) ? $decoded : array();
    }

    private function firstValue($source, $keys, $default = null)
    {
        foreach ($keys as $key) {
            if (is_array($source) && array_key_exists($key, $source)) {
                return $source[$key];
            }
        }

        return $default;
    }

    private function normalizeDigits($value)
    {
        return preg_replace('/\D+/', '', (string)$value);
    }

    // ───────────────────────── notifications fallback ─────────────────────────

    private function detectNotificationDirection($notification)
    {
        $text = trim(
            (isset($notification['title']) ? $notification['title'] : '') . ' ' .
            (isset($notification['message']) ? $notification['message'] : '')
        );

        // "ACB: Acc 37247077(VND) + 50,000 ..."  -> money in  (IN)
        // "ACB: Acc 37247077(VND) - 150,000 ..." -> money out (OUT)
        if (preg_match('/\(VND\)\s*([+\-])/', $text, $match)) {
            return $match[1] === '-' ? 'OUT' : 'IN';
        }

        $textLower = function_exists('mb_strtolower')
            ? mb_strtolower($text, 'UTF-8')
            : strtolower($text);

        foreach (array('ghi nợ', 'debit', 'debited') as $keyword) {
            if (strpos($textLower, $keyword) !== false) {
                return 'OUT';
            }
        }

        return 'IN';
    }

    /** Amount from "(VND) + 50,000": used only when the notification has no amount field. */
    private function notificationAmount($notification)
    {
        if (isset($notification['amount']) && (float)$notification['amount'] != 0) {
            return abs((float)$notification['amount']);
        }

        $text = (isset($notification['title']) ? $notification['title'] : '') . ' ' .
            (isset($notification['message']) ? $notification['message'] : '');
        if (preg_match('/\(VND\)\s*[+\-]\s*([\d.,]+)/', $text, $match)) {
            return (float)str_replace(array(',', '.'), '', $match[1]);
        }

        return 0.0;
    }

    private function selectNotificationsForAccount($notifications, $accountNo)
    {
        $accountDigits = $this->normalizeDigits($accountNo);
        if ($accountDigits === '') {
            return $notifications;
        }

        $matched = array_values(array_filter($notifications, function ($notification) use ($accountDigits) {
            $serialized = json_encode($notification, JSON_UNESCAPED_UNICODE);
            $notificationDigits = $this->normalizeDigits($serialized);
            return strpos($notificationDigits, $accountDigits) !== false;
        }));

        return empty($matched) ? $notifications : $matched;
    }

    private function convertNotification($notification, $accountNo)
    {
        $createdAt = isset($notification['createdAt']) ? (int)$notification['createdAt'] : 0;
        $notificationId = isset($notification['id']) ? $notification['id'] : '';
        $description = isset($notification['message'])
            ? $notification['message']
            : (isset($notification['title']) ? $notification['title'] : '');

        return array(
            'id' => $notificationId,
            'amount' => $this->notificationAmount($notification),
            'transactionNumber' => $notificationId,
            'description' => $description,
            'title' => isset($notification['title']) ? $notification['title'] : '',
            'postingDate' => $createdAt,
            'type' => $this->detectNotificationDirection($notification),
            'currency' => 'VND',
            'account' => $accountNo,
            'source' => 'notifications',
        );
    }

    private function isSuccessfulNotificationResponse($response)
    {
        return is_array($response)
            && isset($response['codeStatus'])
            && (int)$response['codeStatus'] === 200
            && isset($response['data'])
            && is_array($response['data']);
    }

    // ───────────────────────── history ─────────────────────────

    private function historyQuery($accountNo, $fromMs, $toMs, $min, $max)
    {
        return array(
            'account' => $accountNo,
            'transactionType' => 'ALL',
            'from' => $fromMs,
            'to' => $toMs,
            'min' => $min,
            'max' => $max,
        );
    }

    private function resolveHistoryRange($fromMs, $toMs)
    {
        $end = $toMs === null ? (int)(time() * 1000) : (int)$toMs;
        $start = $fromMs === null
            ? $end - (30 * 24 * 60 * 60 * 1000)
            : (int)$fromMs;

        return array($start, $end);
    }

    private function fetchHistory($accountNo, $token, $fromMs, $toMs, $min = '', $max = '')
    {
        $url = $this->appendQuery(
            $this->endpoint('history'),
            $this->historyQuery($accountNo, $fromMs, $toMs, $min, $max)
        );

        return $this->CURL2($url, $this->buildHeaders($token), null);
    }

    /** ACB puts the user's memo after "transaction:"; keep only the memo. */
    public function formatTransactionDescription($description)
    {
        $description = (string)$description;
        $parts = preg_split('/transaction:/i', $description, 2);

        if (is_array($parts) && count($parts) === 2) {
            $description = $parts[1];
        }

        return trim($description, " \t\n\r\0\x0B*");
    }

    /** Same shape for history rows and converted notifications; amount never negative. */
    public function normalizeTransactions($transactions)
    {
        if (!is_array($transactions)) {
            return array();
        }

        $normalized = array_map(function ($transaction) {
            $rawId = $this->firstValue($transaction, array('transactionNumber', 'transactionID'), '');
            $publicId = isset($transaction['id']) && (string)$transaction['id'] !== ''
                ? $transaction['id']
                : $rawId;

            $transaction['transactionNumber'] = str_replace(' ', '', (string)$publicId);
            $transaction['transactionID'] = $transaction['transactionNumber'];
            $transaction['description'] = $this->formatTransactionDescription(
                isset($transaction['description']) ? $transaction['description'] : ''
            );
            $transaction['amount'] = isset($transaction['amount']) ? abs((float)$transaction['amount']) : 0;
            $transaction['type'] = (!isset($transaction['type']) || $transaction['type'] === 'IN') ? 'IN' : 'OUT';
            $transaction['postingDate'] = $this->firstValue($transaction, array('postingDate', 'transactionDate'), 0);

            return $transaction;
        }, array_values($transactions));

        // Newest first, so "the last N" is the first N.
        usort($normalized, function ($a, $b) {
            return (float)$b['postingDate'] <=> (float)$a['postingDate'];
        });

        return $normalized;
    }

    public function isTokenExpiredResponse($data)
    {
        return is_array($data) && (
            array_key_exists('exp', $data)
            || (isset($data['message']) && $data['message'] === 'Unauthorized')
        );
    }

    public function isForbiddenServiceResponse($data)
    {
        return is_array($data)
            && isset($data['message'])
            && $data['message'] === 'You cannot consume this service';
    }

    /**
     * Transactions for $accountNo with ONE token. Returns null when the token expired (caller
     * logs in again), false when ACB failed (see lastError), otherwise the normalised list —
     * from transaction-history, or from the notifications feed when history is blocked.
     */
    public function fetchTransactions($accountNo, $rows, $token)
    {
        $history = $this->decodeResult($this->LSGD($accountNo, $rows, $token));

        if ($this->isTokenExpiredResponse($history)) {
            return null;
        }

        if (isset($history['data']) && is_array($history['data']) && !empty($history['data'])) {
            return array_slice($this->normalizeTransactions($history['data']), 0, max(1, (int)$rows));
        }

        // Token is fine but history is empty or blocked -> notifications.
        $notify = $this->decodeResult($this->Notifications($token, 0, $rows, 'en'));
        if ($this->isTokenExpiredResponse($notify)) {
            return null;
        }
        if ($this->isSuccessfulNotificationResponse($notify)) {
            $notifications = $this->selectNotificationsForAccount($notify['data'], $accountNo);
            $converted = array_map(function ($notification) use ($accountNo) {
                return $this->convertNotification($notification, $accountNo);
            }, $notifications);

            return array_slice($this->normalizeTransactions($converted), 0, max(1, (int)$rows));
        }

        // History answered with an explicit empty list: genuinely no transactions.
        if (isset($history['data']) && is_array($history['data'])) {
            return array();
        }

        // Anything else is a failure, not "no transactions" (that would hide an outage).
        $this->lastError = $this->describeFailure($history) !== ''
            ? $this->describeFailure($history)
            : 'Phản hồi từ ACB không hợp lệ';
        return false;
    }

    private function describeFailure($response)
    {
        if (is_array($response)) {
            foreach (array('error', 'message', 'description') as $key) {
                if (!empty($response[$key]) && is_string($response[$key])) {
                    return $response[$key];
                }
            }
        }
        return '';
    }

    // ───────────────────────── raw API calls (kept for existing callers) ─────────────────────────

    /** Old entry point: logs in with the credentials given to the constructor. */
    public function login()
    {
        return $this->login_acb($this->username, $this->password);
    }

    public function login_acb($username, $password)
    {
        return $this->CURL2(
            $this->endpoint('login'),
            $this->buildHeaders(),
            array(
                'clientId' => $this->clientId,
                'username' => $username,
                'password' => $password,
                'deviceId' => $this->deviceId,
            )
        );
    }

    public function getBankName($tranferTo, $bankCode, $stk, $token)
    {
        $url = $this->appendQuery(
            $this->endpoint('recipient', array($tranferTo)),
            array(
                'bankCode' => $bankCode,
                'accountNumber' => $stk,
            )
        );

        return $this->encodeResult(
            $this->CURL2($url, $this->buildHeaders($token), null)
        );
    }

    public function get_balance($token)
    {
        return $this->encodeResult(
            $this->CURL2(
                $this->endpoint('balance'),
                $this->buildHeaders($token),
                null
            )
        );
    }

    /** JSON string of the raw history response; the last 30 days unless a range is given. */
    public function LSGD($accountNo, $rows, $token, $fromMs = null, $toMs = null, $min = '', $max = '')
    {
        list($from, $to) = $this->resolveHistoryRange($fromMs, $toMs);

        return $this->encodeResult(
            $this->fetchHistory($accountNo, $token, $from, $to, $min, $max)
        );
    }

    public function HistoryforDate($accountNo, $start_date, $end_date, $token)
    {
        $from = (int)(strtotime($start_date . ' 00:00:00') * 1000);
        $to = (int)(strtotime($end_date . ' 23:59:59') * 1000);

        return $this->encodeResult(
            $this->fetchHistory($accountNo, $token, $from, $to, '', '')
        );
    }

    public function Notifications($token, $page = 0, $size = 20, $language = 'en')
    {
        $url = $this->appendQuery(
            $this->endpoint('notifications'),
            array(
                'page' => $page,
                'size' => $size,
                'language' => $language,
            )
        );

        return $this->encodeResult(
            $this->CURL2($url, $this->buildHeaders($token, '3.52.0'), null)
        );
    }

    // ───────────────────────── transport ─────────────────────────

    private function proxyConfiguration()
    {
        $value = $this->proxy;
        if ($value === null || trim((string)$value) === '') {
            return null;
        }

        $parts = explode(':', trim((string)$value), 4);
        if (count($parts) === 4) {
            return array(
                'server' => $parts[0] . ':' . $parts[1],
                'credentials' => $parts[2] . ':' . $parts[3],
            );
        }

        return array('server' => trim((string)$value), 'credentials' => null);
    }

    private function applyProxy($curlHandle)
    {
        $configuration = $this->proxyConfiguration();
        if ($configuration === null) {
            return;
        }

        curl_setopt($curlHandle, CURLOPT_PROXY, $configuration['server']);
        if ($configuration['credentials'] !== null) {
            curl_setopt($curlHandle, CURLOPT_PROXYUSERPWD, $configuration['credentials']);
        }
    }

    private function buildCurlOptions($url, $headers, $payload)
    {
        $hasPayload = !empty($payload);
        $encodedPayload = is_array($payload) ? json_encode($payload) : $payload;
        $insecure = self::env('ACB_INSECURE_SSL', '') === '1';

        $options = array(
            CURLOPT_URL => $url,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CUSTOMREQUEST => $hasPayload ? 'POST' : 'GET',
            CURLOPT_POST => $hasPayload,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_ENCODING => '',
            CURLOPT_HEADER => false,
            CURLOPT_HTTP_VERSION => CURL_HTTP_VERSION_1_1,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_SSL_VERIFYPEER => !$insecure,
            CURLOPT_SSL_VERIFYHOST => $insecure ? 0 : 2,
        );

        if ($hasPayload) {
            $options[CURLOPT_POSTFIELDS] = $encodedPayload;
        }

        return $options;
    }

    public function CURL2($url, $header, $data)
    {
        $curlHandle = curl_init();
        if ($curlHandle === false) {
            return array('error' => 'CURL Error: Cannot initialize cURL');
        }

        curl_setopt_array(
            $curlHandle,
            $this->buildCurlOptions($url, $header, $data)
        );
        $this->applyProxy($curlHandle);

        $body = curl_exec($curlHandle);
        $error = curl_error($curlHandle);
        $httpCode = (int)curl_getinfo($curlHandle, CURLINFO_HTTP_CODE);

        if ($error !== '') {
            return array('error' => 'CURL Error: ' . $error);
        }

        $decoded = json_decode((string)$body, true);
        if (is_array($decoded)) {
            return $decoded;
        }

        // A bare 401 means the token is no longer valid.
        if ($httpCode === 401) {
            return array('message' => 'Unauthorized');
        }

        return $body;
    }
}
