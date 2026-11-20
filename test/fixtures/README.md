# Fixture corpus (milestone 5)

Synthetic OFX exports modeled after commonly observed quirks of Brazilian bank
exports. **No real personal data.** All names are invented and all CPF/CNPJ
numbers are generated with valid check digits by `generate.mjs`, which refuses
to emit a fixture containing an invalid document number.

## Layout

- `<name>.ofx` — the exact bytes of a fixture (UTF-8, windows-1252,
  ISO-8859-1, UTF-16LE+BOM or UTF-32 as noted in the generator).
- `<name>.expected.json` — the complete expected normalized document plus the
  `options` needed to reproduce it. `Money.cents` is a decimal **string** in
  JSON (the runtime value is `bigint`); warnings are asserted as stable codes.
- `generate.mjs` — one-off, deterministic byte-level generator. Run
  `node test/fixtures/generate.mjs` from the repo root to recreate the `.ofx`
  files byte-for-byte.
- `../fixtures.test.ts` — compares every fixture to its expected document and
  additionally asserts hand-derived vectors (amounts, dates, categories,
  counterparties, ids, warnings) so a parser bug cannot be snapshotted away.

## Coverage

| Fixture                    | Quirk modeled                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| 01-itau-sgml-1252          | Itaú-style SGML, real windows-1252 bytes, unclosed leaves, CRLF, `&amp;`/`&lt;`, Pix with masked CPF |
| 02-bradesco-brt-lf         | Closed tags, `[-3:BRT]`, comma decimals, LF, CHECKNUM                                                |
| 03-nubank-card-xml         | Nubank-style OFX 2.x XML, UTF-8, positive purchases, PARC, estorno                                   |
| 04-inter-xml-utf8          | Inter XML 2.x, `<?OFX>` before the XML prolog, accented names                                        |
| 05-caixa-comma-decimals    | Grouped pt-BR numbers, `R$`, DTUSER, savings account                                                 |
| 06-bb-mojibake-utf8        | Header lies (`1252`) but bytes are UTF-8 → `mojibake-repaired`                                       |
| 07-multi-statements        | Two bank accounts + one card in one file; FITIDs scoped per statement                                |
| 08-truncated-mid-stmttrn   | File cut mid-transaction; all enclosing aggregates closed implicitly                                 |
| 09-duplicate-fitids        | Reused FITIDs → `fitid#2/#3` + warnings; missing FITID → deterministic hash                          |
| 10-empty-banktranlist      | Period and balances present, zero transactions                                                       |
| 11-huge-single-line        | Whole body on one line; unclosed `STMTTRN` siblings                                                  |
| 12-lowercase-tags          | Stone-style all-lowercase tags and TRNTYPE values                                                    |
| 13-mixed-case-tags         | Cora-style mismatched opening/closing tag case                                                       |
| 14-entities-raw-ampersand  | Named/numeric entities, raw `&`, unknown entity warning, `&nbsp;`                                    |
| 15-nul-bytes               | NULs in tag names, values and between tags; one `nul-byte` warning                                   |
| 16-cr-only-line-endings    | Legacy CR-only EOL plus an unparsable amount row                                                     |
| 17-trailing-garbage        | Trailing lines after `</OFX>`                                                                        |
| 18-no-header-body-only     | No header at all → `missing-header`, version `unknown`                                               |
| 19-garbage-header          | Recognizable keys, unusable values → version `unknown`                                               |
| 20-utf16le-bom             | UTF-16LE with BOM, accented memos                                                                    |
| 21-iso88591-c1-repair      | Declared ISO-8859-1 with a 0x85 ellipsis (C1) byte                                                   |
| 22-amount-conventions      | Every amount format in SPEC + two known-invalid rows                                                 |
| 23-date-conventions        | All timezone suffixes, clamping (`20240230`) and an invalid date                                     |
| 24-pix-enrichment-zoo      | Every category, full/masked/bare CPF and CNPJ extraction                                             |
| 25-card-signs-installments | Card sign normalization, installments, mislabelled refund                                            |
| 26-balance-mismatch        | `verifyBalance`: one mismatch warning, one exact statement                                           |
| 27-statement-error-status  | Error-only response skipped; nonzero status warns; missing TRNTYPE                                   |
| 28-wrapperless-body        | No `<OFX>` wrapper; message sets at top level                                                        |
| 29-santander-checknum      | CHECKNUM, REFNUM, DTUSER, TED/boleto/Pix memos, CRLF                                                 |
| 30-stray-whitespace-values | Newlines and NBSP inside values; collapsed descriptions                                              |
| 31-duplicated-closing-tags | Repeated `</STMTTRN>`, `</BANKTRANLIST>`, `</OFX>`                                                   |
| 32-one-line-header         | Whole key:value header concatenated on one line                                                      |
| 33-empty                   | Zero-byte file                                                                                       |
| 34-stray-close-tag         | `</NAOEXISTE>` matches no open element                                                               |
| 35-unterminated-comment    | Comment after `</OFX>` has no `-->`                                                                  |
| 36-missing-metadata        | Bad sign-on code, missing CURDEF and ACCTID                                                          |
| 37-custom-timezone         | `tz: '+02:00'` applied to timezone-less datetimes                                                    |
| 38-missing-optional-fields | Missing TRNTYPE/DTPOSTED; XFER direction from amount sign                                            |

The 100k-transaction performance guard lives in `../parse-performance.test.ts`.
