## ADDED Requirements

### Requirement: Buy a plan in the bot
A linked customer SHALL be able to buy a plan from the bot: the plan list offers each plan, a plan offers the payment methods the web checkout would offer to that customer, and choosing one SHALL create the order under the same rules and reply with the exact payment details (QR image when available, bank account or Binance Pay ID, amount, transfer content, expiry). The customer SHALL be able to check the payment, see the details again and cancel a pending order; only the order's owner SHALL see or cancel it. A plan sold by custom amount SHALL offer one and two times its price and a typed amount, quoted (amount and credit) before the payment method is chosen. Multi-period terms and vouchers SHALL point to the web.

#### Scenario: Buy by bank transfer
- **WHEN** a linked customer taps "Mua" on a plan and then "Chuyển khoản VietQR"
- **THEN** a pending order exists with its payment code, and the bot sends the QR with the bank account, amount and transfer content

#### Scenario: Someone else's order
- **WHEN** a customer presses a cancel button for an order that is not theirs
- **THEN** the bot answers that the order was not found and nothing changes

#### Scenario: Custom amount
- **WHEN** a customer taps "Mua" on a custom-amount plan, then "Nhập số tiền", and replies "700k" to the bot's prompt
- **THEN** the bot shows 700.000đ and the credit it buys, and the order created after choosing VietQR is for 700.000đ with that credit

### Requirement: Notifications resume when the customer writes
When a linked customer sends the bot any message or button press, notifications paused because Telegram refused an earlier message SHALL resume.

#### Scenario: Unblocked bot
- **WHEN** a customer who had blocked the bot unblocks it and presses Start
- **THEN** the next notification is sent to them again
