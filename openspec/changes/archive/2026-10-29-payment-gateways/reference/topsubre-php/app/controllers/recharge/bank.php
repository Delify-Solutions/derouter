<?php

header('Content-Type: application/json; charset=utf-8');

if (empty($_SESSION['username']) || empty($auth['id'])) {
    die(json_encode(['status' => 'error', 'msg' => 'Vui lòng đăng nhập']));
}
if (empty($bank) || empty($money) || empty($request_id)) {
    die(json_encode(['status' => 'error', 'msg' => 'Thiếu thông tin bắt buộc']));
}

$rqid = $duogxaolin->site('noi_dung_nap') . $request_id;
$comment = $comment ?? $rqid; 
if ($money < 10000) {
        $return['status'] = 'error';
        $return['msg']   = 'Số Tiền Tối Thiểu Là 10.000đ ';
        die(json_encode($return));
    }
$create =       $duogxaolin->insert("autobank", [
                'amount' => $amount,
                'money'  => $money,
                'c'      => $duogxaolin->site('c'),
                'fees'   => $discount,
                'money_s' => $money_s,
                'comment' => $comment,
                'time'    => time(),
                'update_date' => time(),
                'status' => 'xuly',
                'type' => 'bank',
                'request_id' => $rqid,
                'trans_id' => null,
                'user_id' => $auth['id'],
                'bank_id' => $bank['id'],
                'stk' => $bank['stk'],
                'ctk' => $bank['ctk'],
                'bank' => $bank['code']
                ]);
if($create){
    $return['status'] = 'success';
    $return['msg']   = 'Tạo Yêu Cầu Thành Công ! ';
    $return['href'] = '/recharge/order/'.$rqid;
    die(json_encode($return));
}else{
    $return['status'] = 'error';
    $return['msg']   = 'Lỗi Hệ Thống ! ';
    die(json_encode($return));

}