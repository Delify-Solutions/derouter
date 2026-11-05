## ADDED Requirements

### Requirement: Buy a plan in the bot
A linked customer SHALL be able to buy a plan from the bot: the plan list offers each plan, a plan offers the payment methods the web checkout would offer to that customer, and choosing one SHALL create the order under the same rules and reply with the exact payment details (QR image when available, bank account or Binance Pay ID, amount, transfer content, expiry). The customer SHALL be able to check the payment, see the details again and cancel a pending order; only the order's owner SHALL see or cancel it. Plans sold by custom amount, multi-period terms and vouchers SHALL point to the web.

#### Scenario: Buy by bank transfer
- **WHEN** a linked customer taps "Mua" on a plan and then "Chuyển khoản VietQR"
- **THEN** a pending order exists with its payment code, and the bot sends the QR with the bank account, amount and transfer content

#### Scenario: Someone else's order
- **WHEN** a customer presses a cancel button for an order that is not theirs
- **THEN** the bot answers that the order was not found and nothing changes
