## MODIFIED Requirements

### Requirement: Failed or cancelled streams record what is known
A stream that ends without a normal close (client cancel, upstream error, socket reset, stall) SHALL still be recorded exactly once: the usage the upstream had already reported if any, otherwise a flagged estimate for the output that was actually delivered, otherwise nothing. When the upstream had reported usage but the stream ended before its closing count (Anthropic `message_delta`, a Responses terminal event, an OpenAI usage chunk, a finished Gemini candidate), the recorded output SHALL be the larger of the reported output and the estimate for the delivered output, flagged `estimated` when the estimate is larger; the reported input and cache figures are kept. A stream that closes normally keeps the upstream's own figures. Nothing SHALL be invented for a stream that produced no output.

Residual limit: if a client disconnects after the upstream's finish chunk but before the trailing usage chunk was read, the cancel ends the pipe first, the real usage is not seen, and the row is the flagged estimate even though the true figure was on the wire. Where a translator holds the finish chunk for the usage (an OpenAI upstream behind an Anthropic or Responses client), the same limit applies to the terminal event the client never receives.

#### Scenario: Client cancels after receiving text
- **WHEN** a client aborts a stream after receiving generated text and before any usage arrived
- **THEN** one usage row is recorded for that text, flagged `estimated`

#### Scenario: Upstream dies mid-stream
- **WHEN** the upstream socket is reset after some text was delivered and before any usage
- **THEN** one usage row is recorded for that text, flagged `estimated`

#### Scenario: Anthropic stream cancelled after message_start
- **WHEN** the Anthropic upstream already reported input and cache tokens in `message_start` and the stream is cancelled before any text
- **THEN** those real figures are recorded, not an estimate

#### Scenario: Anthropic stream cancelled after streaming text
- **WHEN** `message_start` reported 1,200 input tokens and `output_tokens: 1`, about 4,000 tokens of text were streamed, and the client cancels before `message_delta`
- **THEN** the row records 1,200 input tokens and about 4,000 output tokens, flagged `estimated`

#### Scenario: Cancelled after the closing count
- **WHEN** an Anthropic stream is cancelled after `message_delta` reported 150 output tokens and before `message_stop`
- **THEN** the row records 150 output tokens, not an estimate

## ADDED Requirements

### Requirement: Embeddings are never served free
An embeddings request served to a client SHALL record usage: the upstream's own count when it reports input tokens (more than zero, no output tokens, and a total equal to the input when a total is given), otherwise an estimate from the request's `input` (text, list of texts, token ids, lists of token ids; a multimodal item without text counts as one flat media item, as in the chat estimate), flagged `estimated`. Only an empty input records nothing.

#### Scenario: Gemini embeddings
- **WHEN** a Gemini embedding request is served (the adapter reports zero tokens) for 400 characters of English text
- **THEN** one usage row is recorded with about 100 input tokens, flagged `estimated`, and charged at the model's input price
