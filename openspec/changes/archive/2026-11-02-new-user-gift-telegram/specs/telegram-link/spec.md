## ADDED Requirements

### Requirement: Link a Telegram account through a Mini App
A signed-in customer SHALL be able to link their account to a Telegram user.
- `POST /api/account/telegram/link` SHALL return a one-time link `https://t.me/<telegramBotUsername>/<telegramMiniAppName>?startapp=<token>`, valid for 10 minutes. Only the token's SHA-256 is stored, and issuing a new token SHALL invalidate the account's earlier unused ones. Without a bot token or bot username configured, the endpoint SHALL answer HTTP 503 with a Vietnamese message.
- The page `/telegram/link`, opened by Telegram as a Mini App, SHALL post Telegram's `initData` to `POST /api/public/telegram/link`.
- The server SHALL accept it only when all of these hold:
  - the `hash` equals HMAC-SHA256 of the data-check string under the key `HMAC_SHA256("WebAppData", telegramBotToken)`;
  - `auth_date` is at most one hour old;
  - `start_param` is a known, unused, unexpired token;
  - the Telegram user is not linked to another account.
- On success it SHALL store `telegramUserId`, `telegramUsername` and `telegramLinkedAt` on the token's account and mark the token used, in one transaction. The page then tells the customer to return to the browser, showing the account's email masked.
- `POST /api/public/telegram/link` SHALL be rate limited per client IP.
- Neither endpoint SHALL return or log the bot token.

#### Scenario: One tap
- **WHEN** a customer taps the link and Telegram opens the Mini App
- **THEN** the account is linked to that Telegram user without any message to the bot

#### Scenario: Forged data
- **WHEN** `initData` with a wrong `hash` is posted
- **THEN** the response is HTTP 400 and nothing is linked

#### Scenario: Reused token
- **WHEN** the same token is used a second time
- **THEN** the response is HTTP 400 "Link đã hết hạn hoặc đã dùng, hãy tạo link mới trên trang web"

### Requirement: One Telegram user per account
A Telegram user SHALL be linked to at most one account. Linking a Telegram user already linked to another account SHALL be refused with HTTP 409 "Tài khoản Telegram này đang liên kết với tài khoản khác". Linking an account that already has a Telegram user SHALL replace it.

#### Scenario: Second account
- **WHEN** Telegram user 42 is linked to account A and account B tries to link 42
- **THEN** B's link is refused and A keeps the link

### Requirement: Link status and unlinking
`GET /api/account/telegram` SHALL return `configured`, `linked`, `telegramUsername` and `linkedAt` for the signed-in customer. `DELETE /api/account/telegram` SHALL clear the link. `/account` SHALL show the link state with a "Liên kết Telegram" or "Gỡ liên kết" action. While a link is pending, the page SHALL poll the status (every 3 seconds, and when the tab regains focus) until linked or the token expires, and SHALL offer "Mở lại Telegram".

#### Scenario: Unlink
- **WHEN** a linked customer unlinks
- **THEN** the account has no Telegram user and another account may link that Telegram user
