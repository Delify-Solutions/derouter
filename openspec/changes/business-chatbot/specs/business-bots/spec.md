## Purpose

Lets a business customer create chatbots bound to its company data. The capability covers bots, bot keys, quotas taken from business plans, the knowledge base (ingestion, chunking, embeddings, retrieval) and the customer portal area where all of this is managed.

## ADDED Requirements

### Requirement: Business quota comes from live business purchases
A customer's business quota SHALL be computed over their live business purchases: `userPlans` rows of a `business` plan with status active and expiry later than now. Credit left on a purchase SHALL NOT matter.
- `maxBots` SHALL be the largest `plans.maxBots` among those purchases.
- `maxKbBytes` SHALL be the largest `plans.maxKbBytes` among those purchases.
- A NULL or 0 value on a plan SHALL count as 0 for that plan.
- The customer SHALL have `hasBusinessPlan = true` when at least one such purchase exists.

`GET /api/account/biz/quota` SHALL return `{ hasBusinessPlan, maxBots, botCount, maxKbBytes, kbBytesUsed }`. `kbBytesUsed` SHALL be the sum, over all the customer's documents, of the UTF-8 byte length of their extracted text.

#### Scenario: Two business purchases
- **WHEN** a customer holds live purchases of business plans with maxBots 1 / maxKbBytes 5 MB and maxBots 3 / maxKbBytes 2 MB
- **THEN** the quota is maxBots 3 and maxKbBytes 5 MB

#### Scenario: Business plan expired
- **WHEN** the customer's only business purchase expired yesterday
- **THEN** `hasBusinessPlan` is false, maxBots is 0, and the existing bots and documents are still listed

### Requirement: Bot lifecycle
A customer SHALL create, list, read, update and delete bots through `/api/account/biz/bots` and `/api/account/biz/bots/[id]`. Each bot has the following fields:

| Field | Rule |
|---|---|
| `name` | required, 1–80 characters |
| `companyName` | required, 1–120 characters |
| `domainDescription` | required, 10–2,000 characters: what the business does and what the bot may talk about |
| `mode` | `strict` or `flexible`; default `strict` |
| `refusalMessage` | 1–500 characters; default "Xin lỗi, tôi chỉ hỗ trợ các câu hỏi liên quan đến <companyName>." |
| `extraInstructions` | 0–2,000 characters |
| `modelId` | must be one of the current business models |
| `isActive` | boolean; default true |

Validation failures SHALL respond 400 with a Vietnamese message naming the field.

Creating a bot SHALL respond 403 with the message "Cần gói AI doanh nghiệp còn hạn để tạo bot" when `hasBusinessPlan` is false. It SHALL respond 403 with "Đã đạt số bot tối đa của gói (<maxBots>)" when `botCount >= maxBots`.

Updating or deleting an existing bot SHALL NOT require a live business plan.

A bot that belongs to another user SHALL respond 404.

Deleting a bot SHALL, in one transaction, delete:
- its keys;
- its documents and chunks;
- its guard events.

#### Scenario: Create within quota
- **WHEN** a customer with maxBots 2 and one bot posts a valid bot
- **THEN** the response is 201 with the bot, and the bot count becomes 2

#### Scenario: Over quota
- **WHEN** a customer with maxBots 1 and one bot posts a bot
- **THEN** the response is 403 "Đã đạt số bot tối đa của gói (1)" and no bot is stored

#### Scenario: Delete cascades
- **WHEN** a customer deletes a bot that has 2 keys, 3 documents and 10 guard events
- **THEN** none of those rows remain, and the bot's keys answer 401 `invalid_api_key`

#### Scenario: Foreign bot
- **WHEN** customer A requests `/api/account/biz/bots/<bot of B>`
- **THEN** the response is 404

### Requirement: Bot keys
Keys of a bot SHALL be created, listed and deleted through `/api/account/biz/bots/[id]/keys`.

A bot key SHALL be a normal customer key owned by the bot's owner, with `botId` set to the bot.

The list response SHALL NOT contain secrets. The secret SHALL be returned:
- once in the creation response;
- afterwards only by `POST /api/account/biz/bots/[id]/keys/[keyId]/secret`, with the same rules as the API key page:
  - owner only; any other key answers 404;
  - `Cache-Control: no-store`;
  - at most 60 times a minute per customer.

A bot key SHALL NOT be pinned to a plan; any `planId` sent SHALL be ignored.

Bot keys SHALL NOT appear in the generic customer key list (`/api/account/keys`). That list SHALL also refuse to create or delete keys that carry a `botId`.

Each bot SHALL have at most 10 keys. An 11th key SHALL be refused with 400 "Mỗi bot tối đa 10 key".

#### Scenario: List carries no secret
- **WHEN** a customer creates a key for bot B and reloads the Key API tab
- **THEN** the listing shows only the prefix and name, and the secret is returned only by the secret endpoint for the owner

#### Scenario: Bot keys hidden from the API key page
- **WHEN** the customer opens `/account/keys`
- **THEN** keys with a `botId` are not listed

### Requirement: Knowledge base ingestion
A customer SHALL add documents to a bot through `POST /api/account/biz/bots/[id]/documents` in one of three forms:
- `file`: multipart upload of a PDF, DOCX, TXT or MD file;
- `text`: a title plus body text;
- `qa`: a title plus 1–500 pairs of `{question, answer}`.

Adding a document SHALL require `hasBusinessPlan`. Without it the response SHALL be 403 "Cần gói AI doanh nghiệp còn hạn để thêm tài liệu".

Size and type checks:
- A file larger than 10 MB SHALL be refused with 413 "Tệp vượt quá 10 MB".
- Any other file type SHALL be refused with 415 "Chỉ hỗ trợ PDF, DOCX, TXT, MD".
- If the extracted text would push `kbBytesUsed` above `maxKbBytes`, the request SHALL be refused with 413 "Vượt dung lượng tài liệu của gói (<used>/<max>)". Nothing SHALL be stored in that case.

Text handling:
- The original file SHALL NOT be stored. Only the extracted text, in chunks, SHALL be stored.
- Text extraction SHALL happen synchronously in the request.
- A PDF or DOCX that yields fewer than 20 non-whitespace characters SHALL be stored as a document with status `failed` and the error "Không đọc được chữ trong tệp (có thể là ảnh scan)".

Embedding and status:
- A document SHALL be created with status `processing`, and the response SHALL be 202.
- Embedding SHALL run in the background.
- When every chunk has an embedding, the status SHALL become `ready` and `chunkCount` SHALL be set.
- If embedding fails, the status SHALL become `failed` with a Vietnamese error. The chunks already extracted SHALL be kept.
- Documents still `processing` when the server restarts SHALL be resumed after startup.

#### Scenario: TXT upload becomes ready
- **WHEN** a customer uploads a 3 KB TXT and the embedding model answers
- **THEN** the response is 202 with status `processing`, and a later listing shows `ready` with chunkCount ≥ 1

#### Scenario: Unsupported type
- **WHEN** a customer uploads `price.xlsx`
- **THEN** the response is 415 "Chỉ hỗ trợ PDF, DOCX, TXT, MD"

#### Scenario: Over knowledge-base size
- **WHEN** kbBytesUsed is 4.9 MB, maxKbBytes is 5 MB, and the new text is 200 KB
- **THEN** the response is 413, and no document is created

#### Scenario: Scanned PDF
- **WHEN** a PDF of images only is uploaded
- **THEN** the document is listed as `failed` with "Không đọc được chữ trong tệp (có thể là ảnh scan)"

#### Scenario: Embedding outage
- **WHEN** the embedding model returns an error during processing
- **THEN** the document becomes `failed` with an error message and keeps its chunks

### Requirement: Chunking
Chunks SHALL be built as follows:
- Extracted `file` and `text` documents SHALL be split on paragraph boundaries into chunks of at most 1,000 characters.
- Consecutive chunks SHALL overlap by 200 characters.
- A single paragraph longer than 1,000 characters SHALL be split at sentence or whitespace boundaries.
- Each `qa` pair SHALL be one chunk with the text `Hỏi: <question>\nĐáp: <answer>`. A pair longer than 2,000 characters SHALL be refused with 400.
- Empty chunks SHALL NOT be stored.

#### Scenario: Long text
- **WHEN** a 2,500-character text without blank lines is chunked
- **THEN** it yields 3 or 4 chunks, each ≤ 1,000 characters, where each chunk after the first starts with the last 200 characters of the previous chunk

#### Scenario: Q&A pair
- **WHEN** a qa document has 2 pairs
- **THEN** it has exactly 2 chunks, each starting with "Hỏi: "

### Requirement: Retry and stale documents
`POST /api/account/biz/bots/[id]/documents/[docId]/retry` SHALL re-embed a `failed` or `stale` document from its stored chunks and set it back to `processing`. Any other status SHALL respond 409.

Each chunk SHALL record the embedding model it was embedded with. When the admin changes the embedding model, every document with a chunk from another model SHALL be reported with status `stale`, and its chunks SHALL be excluded from retrieval until it is retried.

`DELETE …/documents/[docId]` SHALL remove the document and its chunks.

#### Scenario: Model change makes documents stale
- **WHEN** the admin switches the embedding model from A to B
- **THEN** documents embedded with A are listed as `stale`, and none of their chunks are retrieved until retried

### Requirement: Retrieval
For a question, the system SHALL:
1. embed the question with the current embedding model;
2. compute cosine similarity against every chunk of the bot that is embedded with that same model;
3. return at most 5 chunks with a score at or above the admin relevance threshold (default 0.30), ordered by score descending.

A bot with no eligible chunks SHALL return an empty result.

#### Scenario: Top results above threshold
- **WHEN** 8 chunks score 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.2 and 0.1 against the question, with threshold 0.3
- **THEN** retrieval returns the five chunks scoring 0.9 to 0.5, in that order

#### Scenario: Nothing relevant
- **WHEN** every chunk scores below the threshold
- **THEN** retrieval returns no chunks

### Requirement: Customer portal business area
The customer area SHALL show a navigation item "AI doanh nghiệp" leading to `/account/business`.

The page SHALL show:
- the quota line "Bot: <botCount>/<maxBots> · Tài liệu: <used>/<max>";
- the bot list, or an empty state;
- for a customer without a business plan, a notice linking to `/doanh-nghiep`.

Each bot page `/account/business/[id]` SHALL have these tabs:
- **Cài đặt**: the bot fields, save and delete with confirmation.
- **Tài liệu**:
  - upload, paste text and Q&A forms;
  - a list showing title, type, size, chunk count and status;
  - status shown with both icon and text: Đang xử lý, Sẵn sàng, Lỗi, Cần xử lý lại;
  - the error text, plus retry and delete actions.
- **Key API**: create (secret shown once with copy), list and delete; plus a code sample using the bot's model and the base URL.
- **Câu hỏi bị chặn**: the latest 100 guard events, showing time, category label and question excerpt.
- **Chat thử**: a playground.

Every list and form SHALL have loading, empty, error and disabled states. Errors SHALL be shown inline with a retry action.

Every control SHALL be keyboard reachable with visible focus.

#### Scenario: No business plan
- **WHEN** a customer without a business plan opens `/account/business`
- **THEN** the page explains that a business plan is needed, links to `/doanh-nghiep`, and the "Tạo bot" button is disabled with that reason

#### Scenario: Status not by colour alone
- **WHEN** a document has failed
- **THEN** its row shows an error icon and the text "Lỗi", together with the error message

### Requirement: Playground
`POST /api/account/biz/bots/[id]/chat` SHALL send the conversation through the same business pipeline as the public API, using a per-bot key named "Chat thử" owned by the customer. The key SHALL be created on first use and SHALL NOT be shown in the bot's key list. Charges, admission, rate limits and guard rules SHALL therefore apply exactly as for the API.

The playground SHALL show the reply, or the platform error message. When the reply was produced by the guard, it SHALL label it with the category, for example "Đã chặn: chính trị".

#### Scenario: Playground uses the pipeline
- **WHEN** the customer asks the playground "Hoàng Sa của nước nào?"
- **THEN** the reply is the official sovereignty text plus the steer-back sentence, and a guard event is recorded

### Requirement: Admin bot overview
The admin page "AI doanh nghiệp" SHALL list every bot with:
- owner email;
- bot name and company;
- model;
- active state shown as text;
- document count per status;
- the blocked-question count in the last 7 days.

#### Scenario: Admin sees all bots
- **WHEN** two customers each have one bot
- **THEN** the admin list shows both bots with their owners
