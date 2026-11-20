/**
 * One-off generator for the milestone-5 fixture corpus (test/fixtures/*.ofx).
 * Synthetic content, modeled after commonly observed quirks of Brazilian bank
 * exports; every name/CPF/CNPJ is fake (CPF/CNPJ check digits are valid).
 *
 * Text fixtures are written verbatim (exact CRLF/LF/CR line endings).
 * Byte-level fixtures (windows-1252, ISO-8859-1 with C1 bytes, UTF-16LE BOM,
 * NUL corruption, UTF-8-under-a-lying-1252-header) are encoded here and
 * written as raw bytes.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = join(process.cwd(), 'test', 'fixtures');
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- encoders

/** windows-1252 bytes for the Latin-1 + C1 characters used by the corpus. */
function cp1252(text) {
  const C1 = {
    0x2018: 0x91,
    0x2019: 0x92,
    0x201c: 0x93,
    0x201d: 0x94,
    0x2013: 0x96,
    0x2014: 0x97,
    0x2026: 0x85,
  };
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code <= 0xff) bytes.push(code);
    else if (C1[code] !== undefined) bytes.push(C1[code]);
    else throw new Error(`cp1252: ${ch} not encodable`);
  }
  return Uint8Array.from(bytes);
}

/** ISO-8859-1 bytes; the few Windows-1252 C1 characters used here are mapped explicitly. */
function latin1(text) {
  const C1 = {
    0x2018: 0x91,
    0x2019: 0x92,
    0x201c: 0x93,
    0x201d: 0x94,
    0x2013: 0x96,
    0x2014: 0x97,
    0x2026: 0x85,
  };
  const bytes = [];
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code <= 0xff) bytes.push(code);
    else if (C1[code] !== undefined) bytes.push(C1[code]);
    else throw new Error(`latin1: ${ch} not encodable`);
  }
  return Uint8Array.from(bytes);
}

function utf16le(text) {
  const bytes = Uint8Array.from([0xff, 0xfe]);
  const body = new Uint8Array(text.length * 2);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    body[i * 2] = code & 0xff;
    body[i * 2 + 1] = code >> 8;
  }
  return Uint8Array.from([...bytes, ...body]);
}

const utf8 = (text) => new TextEncoder().encode(text);

// ------------------------------------------------------- fake-document check

/** CPF check digits: every document number in the corpus is fake but structurally valid. */
function cpfCheckDigits(base9) {
  const d = base9.split('').map(Number);
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * (10 - i);
  let rest = (sum * 10) % 11;
  const first = rest === 10 ? 0 : rest;
  sum = 0;
  for (let i = 0; i < 9; i++) sum += d[i] * (11 - i);
  sum += first * 2;
  rest = (sum * 10) % 11;
  return `${first}${rest === 10 ? 0 : rest}`;
}

/** CNPJ check digits, same guarantee. */
function cnpjCheckDigits(base12) {
  const d = base12.split('').map(Number);
  const firstWeights = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const secondWeights = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3];
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * firstWeights[i];
  let rest = sum % 11;
  const first = rest < 2 ? 0 : 11 - rest;
  sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * secondWeights[i];
  sum += first * 2;
  rest = sum % 11;
  return `${first}${rest < 2 ? 0 : 11 - rest}`;
}

// Fail loudly if a fixture ever drifts to an invalid document number.
for (const [base, digits] of [
  ['123456789', '09'],
  ['111444777', '35'],
  ['529982247', '25'],
  ['238624710', '47'],
]) {
  if (cpfCheckDigits(base) !== digits) throw new Error(`invalid fake CPF ${base}-${digits}`);
}
if (cnpjCheckDigits('112223330001') !== '81') throw new Error('invalid fake CNPJ');

// ---------------------------------------------------------------- builders

const CRLF = '\r\n';
const LF = '\n';
const CR = '\r';

/** Canonical OFX 1.x key:value header with the given CHARSET/ENCODING lines. */
function ofx1Header(eol, charsetLines) {
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    ...charsetLines,
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '',
  ].join(eol);
}

const HEADER_1252 = (eol) => ofx1Header(eol, ['ENCODING:USASCII', 'CHARSET:1252']);
const HEADER_ASCII = (eol) => ofx1Header(eol, ['ENCODING:USASCII', 'CHARSET:NONE']);

/** Minimal OFX 1.x header (no DATA/SECURITY/CHARSET lines). */
const MIN_HEADER = (eol = LF) =>
  ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(eol);

/** A closed SONRS aggregate. */
function sonrs(eol, org, fid) {
  const fi = org === undefined ? '' : `<FI><ORG>${org}<FID>${fid ?? ''}</FI>`;
  return [
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    '<STATUS>',
    '<CODE>0',
    '<SEVERITY>INFO',
    '</STATUS>',
    `<DTSERVER>20240115120000[-3:BRT]`,
    '<LANGUAGE>POR',
    fi,
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
    '',
  ]
    .filter((line) => line !== '')
    .join(eol);
}

/** One STMTTRN block (Itaú style: leaves unclosed, aggregate closed). */
function trn(fields, eol = LF) {
  const lines = ['<STMTTRN>'];
  for (const [name, value] of Object.entries(fields)) {
    lines.push(`<${name}>${value}`);
  }
  lines.push('</STMTTRN>');
  return lines.join(eol);
}

// ---------------------------------------------------------------- fixtures

const files = new Map();

function text(name, content) {
  files.set(name, utf8(content));
}
function raw(name, bytes) {
  files.set(name, bytes);
}

// 1 — Itaú-style SGML, real windows-1252 bytes, leaves unclosed, CRLF.
{
  const body = [
    '<OFX>',
    sonrs(CRLF, 'ITAU UNIBANCO', '341'),
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<TRNUID>0',
    '<STATUS>',
    '<CODE>0',
    '<SEVERITY>INFO',
    '</STATUS>',
    '<STMTRS>',
    '<CURDEF>BRL',
    '<BANKACCTFROM>',
    '<BANKID>341',
    '<BRANCHID>1234',
    '<ACCTID>999999999999',
    '<ACCTTYPE>CHECKING',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    '<DTSTART>20240101',
    '<DTEND>20240131',
    trn(
      {
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240105083000[-3:BRT]',
        TRNAMT: '-89.90',
        FITID: '2024010500001',
        NAME: 'PAGAMENTO BOLETO',
        MEMO: 'COMPANHIA ENERGÉTICA &amp; FILHOS LTDA',
      },
      CRLF,
    ),
    trn(
      {
        TRNTYPE: 'CREDIT',
        DTPOSTED: '20240110070000[-3:BRT]',
        TRNAMT: '3500.00',
        FITID: '2024011000001',
        NAME: 'CREDITO SALARIO',
        MEMO: 'SALÁRIO REFERENTE JANEIRO/2024',
      },
      CRLF,
    ),
    trn(
      {
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240120101500[-3:BRT]',
        TRNAMT: '-34.90',
        FITID: '2024012000001',
        NAME: 'TARIFA',
        MEMO: 'TARIFAÇÃO &lt;MANUTENÇÃO&gt; CONTA',
      },
      CRLF,
    ),
    trn(
      {
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240125143000[-3:BRT]',
        TRNAMT: '-150.00',
        FITID: '2024012500001',
        NAME: 'PIX',
        MEMO: 'PIX ENVIADO - MARIA APARECIDA SOUZA CPF ***.123.456-**',
      },
      CRLF,
    ),
    '</BANKTRANLIST>',
    '<LEDGERBAL>',
    '<BALAMT>1234.56',
    '<DTASOF>20240131',
    '</LEDGERBAL>',
    '<AVAILBAL>',
    '<BALAMT>1200.56',
    '<DTASOF>20240131',
    '</AVAILBAL>',
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
    '',
  ].join(CRLF);
  raw('01-itau-sgml-1252.ofx', cp1252(HEADER_1252(CRLF) + body));
}

// 2 — Bradesco: everything closed, [-3:BRT] suffixes, comma decimals, LF.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240201120000[-3:BRT]</DTSERVER><FI><ORG>BRADECO</ORG><FID>237</FID></FI></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS><CURDEF>BRL</CURDEF>',
    '<BANKACCTFROM><BANKID>237</BANKID><BRANCHID>1234</BRANCHID><ACCTID>00012345-6</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240201</DTSTART><DTEND>20240229</DTEND>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240201100000[-3:BRT]</DTPOSTED><TRNAMT>-2500,00</TRNAMT><FITID>B-0001</FITID><NAME>DOC</NAME><MEMO>DOC PARA CONTA EM OUTRO BANCO</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>CHECK</TRNTYPE><DTPOSTED>20240205</DTPOSTED><TRNAMT>-100,00</TRNAMT><FITID>B-0002</FITID><CHECKNUM>000123</CHECKNUM><NAME>CHEQUE</NAME><MEMO>CHEQUE NUMERO 000123</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240210090000[-3:BRT]</DTPOSTED><TRNAMT>-45,90</TRNAMT><FITID>B-0003</FITID><NAME>TARIFA</NAME><MEMO>TARIFA MANUTENCAO CONTA</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20240228170000[-3:BRT]</DTPOSTED><TRNAMT>12,34</TRNAMT><FITID>B-0004</FITID><NAME>JUROS</NAME><MEMO>JUROS CREDITADOS</MEMO></STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>8900,54</BALAMT><DTASOF>20240229</DTASOF></LEDGERBAL>',
    '<AVAILBAL><BALAMT>8700,54</BALAMT><DTASOF>20240229</DTASOF></AVAILBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text('02-bradesco-brt-lf.ofx', HEADER_1252(LF) + body);
}

// 3 — Nubank-style credit card, OFX 2.x XML, UTF-8, purchase sign flips, PARC.
{
  const body = [
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
    '<OFX>',
    '  <SIGNONMSGSRSV1>',
    '    <SONRS>',
    '      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '      <DTSERVER>20240201120000</DTSERVER>',
    '      <LANGUAGE>POR</LANGUAGE>',
    '    </SONRS>',
    '  </SIGNONMSGSRSV1>',
    '  <CREDITCARDMSGSRSV1>',
    '    <CCSTMTTRNRS>',
    '      <TRNUID>1</TRNUID>',
    '      <STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '      <CCSTMTRS>',
    '        <CURDEF>BRL</CURDEF>',
    '        <CCACCTFROM><ACCTID>5189********1234</ACCTID></CCACCTFROM>',
    '        <BANKTRANLIST>',
    '          <DTSTART>20240101</DTSTART>',
    '          <DTEND>20240131</DTEND>',
    '          <STMTTRN>',
    '            <TRNTYPE>DEBIT</TRNTYPE>',
    '            <DTPOSTED>20240110093700.000[-3:BRT]</DTPOSTED>',
    '            <TRNAMT>137.90</TRNAMT>',
    '            <FITID>2024-01-10T09:37:00.000Z</FITID>',
    '            <NAME>PADARIA PÃO DOCE LTDA</NAME>',
    '            <MEMO>Compra cartão</MEMO>',
    '          </STMTTRN>',
    '          <STMTTRN>',
    '            <TRNTYPE>DEBIT</TRNTYPE>',
    '            <DTPOSTED>20240115203000.000[-3:BRT]</DTPOSTED>',
    '            <TRNAMT>320.00</TRNAMT>',
    '            <FITID>2024-01-15T20:30:00.000Z</FITID>',
    '            <NAME>LOJA MAIÔ MODA PRAIA LTDA</NAME>',
    '            <MEMO>Compra parcelada PARC 02/10</MEMO>',
    '          </STMTTRN>',
    '          <STMTTRN>',
    '            <TRNTYPE>CREDIT</TRNTYPE>',
    '            <DTPOSTED>20240118201500.000[-3:BRT]</DTPOSTED>',
    '            <TRNAMT>-50.00</TRNAMT>',
    '            <FITID>2024-01-18T20:15:00.000Z</FITID>',
    '            <NAME>ESTORNO PADARIA PÃO DOCE LTDA</NAME>',
    '            <MEMO>Estorno compra cartão</MEMO>',
    '          </STMTTRN>',
    '          <STMTTRN>',
    '            <TRNTYPE>CREDIT</TRNTYPE>',
    '            <DTPOSTED>20240125120000.000[-3:BRT]</DTPOSTED>',
    '            <TRNAMT>1500.00</TRNAMT>',
    '            <FITID>2024-01-25T12:00:00.000Z</FITID>',
    '            <NAME>PAGAMENTO FATURA</NAME>',
    '            <MEMO>PAGAMENTO DE FATURA CARTAO</MEMO>',
    '          </STMTTRN>',
    '        </BANKTRANLIST>',
    '        <LEDGERBAL><BALAMT>-123.45</BALAMT><DTASOF>20240131</DTASOF></LEDGERBAL>',
    '      </CCSTMTRS>',
    '    </CCSTMTTRNRS>',
    '  </CREDITCARDMSGSRSV1>',
    '</OFX>',
    '',
  ].join(LF);
  text('03-nubank-card-xml.ofx', body);
}

// 4 — Inter: OFX 2.x PI before the XML prolog, UTF-8 accents.
{
  const body = [
    '<?OFX OFXHEADER="200" VERSION="200" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>',
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240301120000[-3:BRT]</DTSERVER><FI><ORG>BANCO INTER</ORG><FID>077</FID></FI></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>2</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS><CURDEF>BRL</CURDEF>',
    '<BANKACCTFROM><BANKID>077</BANKID><BRANCHID>0001</BRANCHID><ACCTID>9182736455463728</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240131</DTEND>',
    '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20240105091200[-3:BRT]</DTPOSTED><TRNAMT>2500.00</TRNAMT><FITID>INT-PIX-001</FITID><NAME>PIX</NAME><MEMO>PIX RECEBIDO - JOÃO DAS CRUZES ALMEIDA</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240108103000[-3:BRT]</DTPOSTED><TRNAMT>-300.00</TRNAMT><FITID>INT-SAQ-001</FITID><NAME>SAQUE</NAME><MEMO>SAQUE CAIXA ELETRONICO 24H</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240112214000[-3:BRT]</DTPOSTED><TRNAMT>-89.90</TRNAMT><FITID>INT-IOF-001</FITID><NAME>IOF</NAME><MEMO>IOF COMPRA INTERNACIONAL</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240115180000[-3:BRT]</DTPOSTED><TRNAMT>-145.67</TRNAMT><FITID>INT-BOL-001</FITID><NAME>BOLETO</NAME><MEMO>BOLETO PAGO COMPANHIA DE GÁS CANHOTO</MEMO></STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>1964.43</BALAMT><DTASOF>20240131</DTASOF></LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text('04-inter-xml-utf8.ofx', body);
}

// 5 — Caixa: pt-BR comma decimals, grouped thousands, R$ prefix, DTUSER.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240131</DTSERVER><LANGUAGE>POR</LANGUAGE><FI><ORG>CAIXA ECONOMICA FEDERAL</ORG><FID>104</FID></FI></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>3</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS><CURDEF>BRL</CURDEF>',
    '<BANKACCTFROM><BANKID>104</BANKID><BRANCHID>3123</BRANCHID><ACCTID>00000012345-6</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240102</DTSTART><DTEND>20240130</DTEND>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240105</DTPOSTED><TRNAMT>-1.234,56</TRNAMT><FITID>CX-01</FITID><NAME>DEBITO CONTA</NAME><MEMO>PAGAMENTO CONTA LUZ</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20240110</DTPOSTED><TRNAMT>2.500,00</TRNAMT><FITID>CX-02</FITID><NAME>DEPOSITO</NAME><MEMO>DEPOSITO EM DINHEIRO GUICHE</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240115</DTPOSTED><TRNAMT>R$ 10,00</TRNAMT><FITID>CX-03</FITID><NAME>TARIFA</NAME><MEMO>TARIFA EXTRATO MENSAL</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20240120</DTPOSTED><DTUSER>20240119</DTUSER><TRNAMT>35.000,00</TRNAMT><FITID>CX-04</FITID><NAME>RENDIMENTO</NAME><MEMO>RENDIMENTO POUPANCA APLICACAO</MEMO></STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>1.234,56</BALAMT><DTASOF>20240130</DTASOF></LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text('05-caixa-comma-decimals.ofx', HEADER_1252(LF) + body);
}

// 6 — BB: header says 1252 but the bytes are UTF-8 (mojibake repair).
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER><FI><ORG>BANCO DO BRASIL</ORG><FID>001</FID></FI></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>4</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS><CURDEF>BRL</CURDEF>',
    '<BANKACCTFROM><BANKID>001</BANKID><BRANCHID>1234-5</BRANCHID><ACCTID>12345678901234567890</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240115</DTEND>',
    '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20240103081200[-3:BRT]</DTPOSTED><TRNAMT>1800.00</TRNAMT><FITID>BB-PX-01</FITID><NAME>PIX</NAME><MEMO>PIX RECEBIDO - LUCIANA PRADO MORAIS</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240105091500[-3:BRT]</DTPOSTED><TRNAMT>-42.00</TRNAMT><FITID>BB-PX-02</FITID><NAME>PIX</NAME><MEMO>PIX ENVIADO - RAIMUNDO NONATO CUNHA CPF 111.444.777-35</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240110090000[-3:BRT]</DTPOSTED><TRNAMT>-59,90</TRNAMT><FITID>BB-BOL-01</FITID><NAME>PAGAMENTO</NAME><MEMO>BOLETO PAGO COMPANHIA ELÉTRICA SUL LTDA</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240114140000[-3:BRT]</DTPOSTED><TRNAMT>-15,00</TRNAMT><FITID>BB-TAR-01</FITID><NAME>TARIFA</NAME><MEMO>TARIFA PACOTE DE SERVIÇOS</MEMO></STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>1683,10</BALAMT><DTASOF>20240115</DTASOF></LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(CRLF);
  raw('06-bb-mojibake-utf8.ofx', utf8(HEADER_1252(CRLF) + body));
}

// 7 — Multiple statements: two bank accounts + one credit card.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>BRL</CURDEF><BANKACCTFROM><BANKID>001</BANKID><BRANCHID>1234</BRANCHID><ACCTID>1111-22222-3</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240115</DTEND>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240102</DTPOSTED><TRNAMT>-10.00</TRNAMT><FITID>tx-1</FITID><NAME>PIX</NAME><MEMO>PIX ENVIADO - ANA BEATRIZ LOPES</MEMO></STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>990.00</BALAMT><DTASOF>20240115</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS>',
    '<STMTTRNRS><TRNUID>2</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>BRL</CURDEF><BANKACCTFROM><BANKID>001</BANKID><BRANCHID>1234</BRANCHID><ACCTID>3333-44444-5</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM><BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240115</DTEND>',
    '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20240105</DTPOSTED><TRNAMT>500.00</TRNAMT><FITID>tx-1</FITID><NAME>DEPOSITO</NAME><MEMO>DEPOSITO POUPANCA</MEMO></STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>500.00</BALAMT><DTASOF>20240115</DTASOF></LEDGERBAL></STMTRS></STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>3</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><CCSTMTRS><CURDEF>BRL</CURDEF><CCACCTFROM><ACCTID>4111********7777</ACCTID></CCACCTFROM><BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240115</DTEND>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240110</DTPOSTED><TRNAMT>-49.90</TRNAMT><FITID>cc-1</FITID><NAME>NETFLIX BRASIL</NAME></STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>-49.90</BALAMT><DTASOF>20240115</DTASOF></LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>',
    '</OFX>',
    '',
  ].join(LF);
  text(
    '07-multi-statements.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 8 — Truncated mid-transaction: no closing tags at the end at all.
{
  const head = ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF);
  const body = [
    '<OFX>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<STMTRS>',
    '<CURDEF>BRL',
    '<BANKACCTFROM>',
    '<BANKID>260',
    '<BRANCHID>0001',
    '<ACCTID>900000000001',
    '<ACCTTYPE>CHECKING',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    '<DTSTART>20240101',
    '<DTEND>20240131',
    trn(
      {
        TRNTYPE: 'CREDIT',
        DTPOSTED: '20240105',
        TRNAMT: '1000.00',
        FITID: 'NU-1',
        MEMO: 'PIX RECEBIDO - OTAVIO AUGUSTO RAMOS',
      },
      LF,
    ),
    trn(
      {
        TRNTYPE: 'DEBIT',
        DTPOSTED: '20240120',
        TRNAMT: '-42.10',
        FITID: 'NU-2',
        MEMO: 'COMPRA CARTAO PADARIA BOM SABOR',
      },
      LF,
    ),
    // Cut off mid-transaction: TRNAMT present, everything after is missing.
    '<STMTTRN>',
    '<TRNTYPE>DEBIT',
    '<DTPOSTED>20240131',
    '<TRNAMT>-42.10',
  ].join(LF);
  text('08-truncated-mid-stmttrn.ofx', head + body);
}

// 9 — Duplicate FITIDs (kept, made unique) + one row with no FITID at all.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>341</BANKID><ACCTID>999888777666555</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST>',
    trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240102', TRNAMT: '-10.00', FITID: 'DUP' }),
    trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240103', TRNAMT: '-20.00', FITID: 'DUP' }),
    trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240104', TRNAMT: '30.00', FITID: 'DUP' }),
    trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240105', TRNAMT: '5.00', MEMO: 'SEM FITID' }),
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '09-duplicate-fitids.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 10 — Empty BANKTRANLIST (dates but no transactions), Sicoob.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>9</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS><CURDEF>BRL</CURDEF><BANKACCTFROM><BANKID>756</BANKID><BRANCHID>3030</BRANCHID><ACCTID>12345-1</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240131</DTEND></BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>5000.00</BALAMT><DTASOF>20240131</DTASOF></LEDGERBAL>',
    '<AVAILBAL><BALAMT>4800.00</BALAMT><DTASOF>20240131</DTASOF></AVAILBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '10-empty-banktranlist.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 11 — The whole body on one huge line (C6-style export).
{
  const body =
    '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20240301120000[-3:BRT]</SONRS></SIGNONMSGSRSV1>' +
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>7<STMTRS><CURDEF>BRL<BANKACCTFROM><BANKID>336<BRANCHID>0001<ACCTID>777888999000111</BANKACCTFROM>' +
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131' +
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105090000[-3:BRT]<TRNAMT>-25.90<FITID>C6-1<NAME>MERCADO<MEMO>COMPRA NO MERCADO BAIRRO COMPLEMENTO' +
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240110080000[-3:BRT]<TRNAMT>3200.00<FITID>C6-2<NAME>PIX<MEMO>PIX RECEBIDO - TATIANE BARBOSA LIMA' +
    '</BANKTRANLIST><LEDGERBAL><BALAMT>3174.10<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
  text('11-huge-single-line.ofx', HEADER_1252(CRLF) + body + CRLF);
}

// 12 — All-lowercase tags (Stone-style), lowercase TRNTYPE values.
{
  const body = [
    '<ofx>',
    '<signonmsgsrsv1><sonrs><status><code>0</code><severity>INFO</severity></status><dtserver>20240115120000[-3:BRT]</dtserver></sonrs></signonmsgsrsv1>',
    '<bankmsgsrsv1><stmttrnrs><trnuid>5</trnuid><status><code>0</code><severity>INFO</severity></status>',
    '<stmtrs><curdef>BRL</curdef>',
    '<bankacctfrom><bankid>197</bankid><branchid>0001</branchid><acctid>555666777888</acctid><accttype>CHECKING</accttype></bankacctfrom>',
    '<banktranlist><dtstart>20240101</dtstart><dtend>20240131</dtend>',
    '<stmttrn><trntype>debit</trntype><dtposted>20240105103000[-3:BRT]</dtposted><trnamt>-19.90</trnamt><fitid>ST-1</fitid><name>PAGAMENTO</name><memo>PAGAMENTO CONTA AGUA</memo></stmttrn>',
    '<stmttrn><trntype>credit</trntype><dtposted>20240110</dtposted><trnamt>2400,00</trnamt><fitid>ST-2</fitid><name>RECEBIMENTO</name><memo>DEPOSITO VIA BOLETO BANCARIO</memo></stmttrn>',
    '</banktranlist><ledgerbal><balamt>2380,10</balamt><dtasof>20240131</dtasof></ledgerbal>',
    '</stmtrs></stmttrnrs></bankmsgsrsv1></ofx>',
    '',
  ].join(LF);
  text('12-lowercase-tags.ofx', HEADER_1252(LF) + body);
}

// 13 — Mismatched case between opening and closing tags (Cora-style).
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><Severity>INFO</Severity></STATUS><DtServer>20240115120000[-3:BRT]</DtServer></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>6</TRNUID><Status><CODE>0</CODE><SEVERITY>INFO</SEVERITY></Status>',
    '<STMTRS><CurDef>BRL</CurDef><BANKACCTFROM><BankId>403</BankId><BranchId>0001</BranchId><AcctId>999111222333444</AcctId><AcctType>CHECKING</AcctType></BANKACCTFROM>',
    '<BANKTRANLIST><DtStart>20240101</DtStart><DtEnd>20240131</DtEnd>',
    '<STMTTRN><TrnType>DEBIT</TrnType><DtPosted>20240105120000[-3:BRT]</DtPosted><TrnAmt>-88.44</TrnAmt><FitId>MX-1</FitId><Name>SAQUE</Name><Memo>SAQUE TERMINAL 24H</Memo></StmtTrn>',
    '<STMTTRN><TrnType>CREDIT</TrnType><DtPosted>20240110120000[-3:BRT]</DtPosted><TrnAmt>599,00</TrnAmt><FitId>MX-2</FitId><Name>DEPOSITO</Name><Memo>DEPOSITO BOLETO</Memo></STMTTRN>',
    '</BANKTRANLIST><LedgerBal><BalAmt>510,56</BalAmt><DtAsOf>20240131</DtAsOf></LedgerBal>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '13-mixed-case-tags.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 14 — Entities (&amp; &lt; &#65; &nbsp;), raw &, unknown entity warning.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>341</BANKID><ACCTID>444555666777</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105090000[-3:BRT]<TRNAMT>-10.00<FITID>EN-1<NAME>MERCADO<MEMO>MERCADO &amp; CIA LTDA</STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240106100000[-3:BRT]<TRNAMT>-20.00<FITID>EN-2<NAME>AVISO<MEMO>ATENCAO &lt;VALOR&gt; LIMITE 100</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240107110000[-3:BRT]<TRNAMT>30.00<FITID>EN-3<NAME>CODIGO<MEMO>LETRAS &#65;&#66;&#67; FINAL</STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240108120000[-3:BRT]<TRNAMT>-40.00<FITID>EN-4<NAME>LANCHE<MEMO>BAR & LANCHONETE EXPRESS</STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240109130000[-3:BRT]<TRNAMT>-50.00<FITID>EN-5<NAME>PENDENCIA<MEMO>PAGAMENTO &foo; PENDENTE</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240110140000[-3:BRT]<TRNAMT>60.00<FITID>EN-6<NAME>ESPACO<MEMO>TARIFA&nbsp;&nbsp;MENSAL</STMTTRN>',
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '14-entities-raw-ampersand.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 15 — NUL bytes leaked by a broken exporter: in a tag, in values, between tags.
{
  const body = [
    '<OFX>',
    '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>208</BANKID><ACCTID>888999000111222</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    // Tag name corrupted: <MEM\0O> never becomes <MEMO> — the memo is lost, the row survives.
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105090000[-3:BRT]<TRNAMT>-12.00<FITID>NB-1<NAME>PAGAMENTO CONTA<MEM\0O>DETALHE PERDIDO</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240106100000[-3:BRT]<TRNAMT>100.00<FITID>NB-2<NAME>PIX<MEMO>PIX \0 RECEBIDO - FERNANDA CAMARGO</STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240107110000[-3:BRT]<TRNAMT>10\0,50<FITID>NB-3<NAME>COMPRA<MEMO>COMPRA CARTAO LOJA CENTRAL</STMTTRN>',
    '\0',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>77,50<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  raw(
    '15-nul-bytes.ofx',
    utf8(['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body),
  );
}

// 16 — CR-only line endings (legacy Mac exporter), plus an unparsable amount.
{
  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '',
  ].join(CR);
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS><CURDEF>BRL</CURDEF>',
    '<BANKACCTFROM><BANKID>041</BANKID><BRANCHID>0199</BRANCHID><ACCTID>2222333344445555</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240115</DTEND>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240105080000[-3:BRT]</DTPOSTED><TRNAMT>-15,00</TRNAMT><FITID>R-1</FITID><NAME>TARIFA</NAME><MEMO>TARIFA CONTA</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240108</DTPOSTED><TRNAMT>****</TRNAMT><FITID>R-2</FITID><NAME>PENDENTE</NAME><MEMO>VALOR INDISPONIVEL</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20240110100000[-3:BRT]</DTPOSTED><TRNAMT>200,00</TRNAMT><FITID>R-3</FITID><NAME>DEPOSITO</NAME><MEMO>DEPOSITO CHEQUE</MEMO></STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>185,00</BALAMT><DTASOF>20240115</DTASOF></LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(CR);
  text('16-cr-only-line-endings.ofx', header + body);
}

// 17 — Trailing garbage after </OFX>.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>323</BANKID><ACCTID>7777000111222333</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240105<TRNAMT>85,00<FITID>MP-1<NAME>RECEBIMENTO<MEMO>RECEBIMENTO VENDA ONLINE</STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>85,00<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    'FIM DO ARQUIVO',
    'GERADO EM 31/01/2024 12:00:00',
    '',
  ].join(LF);
  text(
    '17-trailing-garbage.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 18 — No header at all: the body starts at <OFX>.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>260</BANKID><ACCTID>1234-5</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105<TRNAMT>-1.00<FITID>NH-1<NAME>PIX<MEMO>PIX ENVIADO - TESTE DE SOBRENOME</STMTTRN>',
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text('18-no-header-body-only.ofx', body);
}

// 19 — Garbage header: recognizable keys, unusable values.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>336</BANKID><ACCTID>555444333222111</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105<TRNAMT>-2.50<FITID>GH-1<NAME>TARIFA<MEMO>TARIFA TRANSFERENCIA</STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>997,50<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '19-garbage-header.ofx',
    ['OFXHEADER:ABC', 'COMMENT:GERADO POR SISTEMA LEGADO', '', ''].join(LF) + body,
  );
}

// 20 — UTF-16LE with BOM (Windows tool export), accents included.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>655</BANKID><BRANCHID>0001</BRANCHID><ACCTID>321654987000</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105093000[-3:BRT]<TRNAMT>-18,90<FITID>U1-1<NAME>TARIFA<MEMO>TARIFAÇÃO DE MANUTENÇÃO</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240110100000[-3:BRT]<TRNAMT>750,00<FITID>U1-2<NAME>PIX<MEMO>PIX RECEBIDO - GABRIELA MARTINS DUARTE</STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>731,10<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:USASCII',
    'CHARSET:1252',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '',
  ].join(LF);
  raw('20-utf16le-bom.ofx', utf16le(header + body));
}

// 21 — ISO-8859-1 declared, with a C1 byte (0x85 ellipsis) in a value.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>748</BANKID><BRANCHID>0478</BRANCHID><ACCTID>1122334455667788</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240105<TRNAMT>-9,90<FITID>SC-1<NAME>TARIFA<MEMO>TARIFA MANUTENÇÃO …</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240110<TRNAMT>123,45<FITID>SC-2<NAME>DEPOSITO<MEMO>DEPOSITO EM CHEQUE NA BANCECA… TESTE</STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>113,55<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  const header = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'SECURITY:NONE',
    'ENCODING:ISO-8859-1',
    'CHARSET:NONE',
    'COMPRESSION:NONE',
    'OLDFILEUID:NONE',
    'NEWFILEUID:NONE',
    '',
    '',
  ].join(LF);
  raw('21-iso88591-c1-repair.ofx', latin1(header + body));
}

// 22 — Amount conventions zoo (two unparsable rows at the end).
{
  const rows = [
    ['A1', '-1234.56'],
    ['A2', '-1234,56'],
    ['A3', '1.234,56'],
    ['A4', '1,234.56'],
    ['A5', '+10'],
    ['A6', 'R$ 10,00'],
    ['A7', ' 2.500 '],
    ['A8', '35.000,00'],
    ['A9', ',50'],
    ['A10', '1,2345'],
  ]
    .map(([id, amount]) =>
      trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240105', TRNAMT: amount, FITID: id }),
    )
    .join(LF);
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>104</BANKID><ACCTID>00011122233344</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    rows,
    trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240106', TRNAMT: 'N/D', FITID: 'A11' }),
    trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240107', FITID: 'A12' }),
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '22-amount-conventions.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 23 — Date conventions zoo (one clamped-only, one hopeless).
{
  const dates = [
    ['D1', '20240115'],
    ['D2', '20240115120000'],
    ['D3', '20240115120000.000'],
    ['D4', '20240115120000.500[-3:BRT]'],
    ['D5', '20240115120000[-03:EST]'],
    ['D6', '20240115120000[0:GMT]'],
    ['D7', '20240115120000[-3]'],
    ['D8', '20240115120000[+05:30]'],
    ['D9', '20240230'],
    ['D10', '20241301000000'],
    ['D11', '15/01/2024'],
  ]
    .map(([id, date]) => trn({ TRNTYPE: 'DEBIT', DTPOSTED: date, TRNAMT: '-1.00', FITID: id }))
    .join(LF);
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>341</BANKID><ACCTID>777888999000111</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    dates,
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '23-date-conventions.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 24 — Enrichment zoo: every category, CPF/CNPJ full/masked/bare.
{
  const memos = [
    ['P1', 'PIX ENVIADO - MARIA APARECIDA SOUZA CPF 123.456.789-09'],
    ['P2', 'PIX RECEBIDO DE JOSE CARLOS OLIVEIRA CPF ***.238.624-**'],
    ['P3', 'PIX ENVIADO CPF 52998224725'],
    ['P4', 'TED PARA MERCADINHO VIZINHO LTDA CNPJ 11.222.333/0001-81'],
    ['P5', 'DOC RECEBIDO DE FARMACIA SAO JOAO'],
    ['P6', 'BOLETO PAGO COMPANHIA DE GAS'],
    ['P7', 'TARIFA MANUTENCAO CONTA'],
    ['P8', 'IOF COMPRA INTERNACIONAL'],
    ['P9', 'JUROS CREDITADOS MES'],
    ['P10', 'ESTORNO COMPRA CARTAO'],
    ['P11', 'SAQUE CAIXA ELETRONICO'],
    ['P12', 'TRANSFERENCIA ENVIADA - ALUGUEL APARTAMENTO'],
    ['P13', 'COMPRA CARTAO DEBITO MERCADO BAIRRO'],
  ]
    .map(([id, memo]) =>
      trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240105', TRNAMT: '-10.00', FITID: id, MEMO: memo }),
    )
    .join(LF);
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>077</BANKID><ACCTID>666555444333222</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    memos,
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '24-pix-enrichment-zoo.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 25 — Credit-card sign normalization + installment variants.
{
  const body = [
    '<OFX><SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20240115120000[-3:BRT]</SONRS></SIGNONMSGSRSV1>',
    '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL',
    '<CCACCTFROM><ACCTID>5555********6666</CCACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240110093700[-3:BRT]<TRNAMT>137.90<FITID>CS-1<NAME>PADARIA PÃO DOCE LTDA<MEMO>Compra cartão</STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240115203000[-3:BRT]<TRNAMT>-320.00<FITID>CS-2<NAME>LOJA MAIÔ MODA PRAIA<MEMO>PARC 02/10</STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240118081500[-3:BRT]<TRNAMT>200.00<FITID>CS-3<MEMO>COMPRA PARCELADA PARC 03/06</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240120120000[-3:BRT]<TRNAMT>-50.00<FITID>CS-4<NAME>ESTORNO<MEMO>ESTORNO COMPRA CARTAO</STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20240125120000[-3:BRT]<TRNAMT>1500.00<FITID>CS-5<NAME>PAGAMENTO<MEMO>PAGAMENTO DE FATURA</STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240128194500[-3:BRT]<TRNAMT>90.00<FITID>CS-6<MEMO>COMPRA ONLINE PARC12/48</STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240129110000[-3:BRT]<TRNAMT>25.00<FITID>CS-7<MEMO>ESTORNO COMPRA CARTAO</STMTTRN>',
    '</BANKTRANLIST><LEDGERBAL><BALAMT>-917,10<DTASOF>20240131</LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '25-card-signs-installments.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 26 — verifyBalance: first statement mismatches, the second is exact.
{
  const body = [
    '<OFX><BANKMSGSRSV1>',
    '<STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>212</BANKID><ACCTID>1111</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240102', TRNAMT: '-100.00', FITID: 'BM-1' }),
    trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240103', TRNAMT: '50.00', FITID: 'BM-2' }),
    '</BANKTRANLIST><LEDGERBAL><BALAMT>0.01<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS>',
    '<STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>212</BANKID><ACCTID>2222</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240104', TRNAMT: '75.00', FITID: 'BM-3' }),
    '</BANKTRANLIST><LEDGERBAL><BALAMT>75.00<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS>',
    '</BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '26-balance-mismatch.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 27 — Statement-level status problems: one ERROR, one nonzero WARN.
{
  const body = [
    '<OFX><BANKMSGSRSV1>',
    '<STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>2000</CODE><SEVERITY>ERROR</SEVERITY><MESSAGE>CONTA INEXISTENTE</MESSAGE></STATUS></STMTTRNRS>',
    '<STMTTRNRS><TRNUID>2</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>341</BANKID><ACCTID>5555-66666-7</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240105', TRNAMT: '-5.00', FITID: 'SE-1' }),
    '</BANKTRANLIST></STMTRS></STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>3</TRNUID><STATUS><CODE>1</CODE><SEVERITY>WARN</SEVERITY></STATUS><CCSTMTRS><CURDEF>BRL',
    '<CCACCTFROM><ACCTID>4111********0000</ACCTID></CCACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({ DTPOSTED: '20240106', TRNAMT: '-25.00', FITID: 'SE-2', MEMO: 'PAGAMENTO CONTA' }),
    '</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '27-statement-error-status.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 28 — Wrapper-less body: no <OFX>, no header, message sets at the top.
{
  const body = [
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<STMTTRNRS><TRNUID>1</TRNUID><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>077</BANKID><ACCTID>1</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240101', TRNAMT: '-1.00', FITID: 't1' }),
    '</BANKTRANLIST></STMTRS></STMTTRNRS>',
    '',
  ].join(LF);
  text('28-wrapperless-body.ofx', body);
}

// 29 — Santander: closed tags, CHECKNUM/REFNUM/DTUSER, TED/Pix/boleto memos.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20240115120000[-3:BRT]</DTSERVER><FI><ORG>BANCO SANTANDER</ORG><FID>033</FID></FI></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><TRNUID>1</TRNUID><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS>',
    '<STMTRS><CURDEF>BRL</CURDEF>',
    '<BANKACCTFROM><BANKID>033</BANKID><BRANCHID>0303</BRANCHID><ACCTID>01020304-5</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101</DTSTART><DTEND>20240131</DTEND>',
    '<STMTTRN><TRNTYPE>CHECK</TRNTYPE><DTPOSTED>20240105090000[-3:BRT]</DTPOSTED><DTUSER>20240104</DTUSER><TRNAMT>-100,00</TRNAMT><FITID>SN-1</FITID><CHECKNUM>000123</CHECKNUM><REFNUM>SN-991</REFNUM><NAME>CHEQUE</NAME><MEMO>CHEQUE COMPENSADO</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240108100000[-3:BRT]</DTPOSTED><TRNAMT>-1.500,00</TRNAMT><FITID>SN-2</FITID><NAME>TED</NAME><MEMO>TED PARA ITAU UNIBANCO CONTA SALARIO</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20240112140000[-3:BRT]</DTPOSTED><TRNAMT>300,00</TRNAMT><FITID>SN-3</FITID><NAME>PIX</NAME><MEMO>PIX RECEBIDO - CARLA MENDES ROCHA</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240115160000[-3:BRT]</DTPOSTED><TRNAMT>-2.500,00</TRNAMT><FITID>SN-4</FITID><NAME>BOLETO</NAME><MEMO>BOLETO PAGO INSTITUICAO EDUCACIONAL SABER LTDA</MEMO></STMTTRN>',
    '<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20240120110000[-3:BRT]</DTPOSTED><TRNAMT>-28,90</TRNAMT><FITID>SN-5</FITID><NAME>TARIFA</NAME><MEMO>TARIFA CANCELAMENTO CHEQUE</MEMO></STMTTRN>',
    '</BANKTRANLIST>',
    '<LEDGERBAL><BALAMT>471,10</BALAMT><DTASOF>20240131</DTASOF></LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(CRLF);
  text('29-santander-checknum.ofx', HEADER_1252(CRLF) + body);
}

// 30 — Values with stray whitespace: own lines, runs, NBSP.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>380</BANKID><ACCTID>1213141516</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    '<STMTTRN>',
    '<TRNTYPE>',
    'DEBIT',
    '<DTPOSTED>  20240105  ',
    '<TRNAMT>',
    '   -10,50',
    '<FITID>WS-1',
    '<NAME>PAGAMENTO',
    '   BOLETO',
    '   NUMERO 12345',
    '</NAME>',
    '<MEMO>ESTORNO\u00a0\u00a0TARIFA\u00a0 BANCARIA</MEMO>',
    '</STMTTRN>',
    trn({
      TRNTYPE: 'CREDIT',
      DTPOSTED: '20240110',
      TRNAMT: '2.000,00',
      FITID: 'WS-2',
      NAME: 'DEPOSITO',
      MEMO: 'DEPOSITO EM DINHEIRO',
    }),
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text(
    '30-stray-whitespace-values.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 31 — Duplicated closing tags.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>237</BANKID><ACCTID>987654321-0</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({ TRNTYPE: 'DEBIT', DTPOSTED: '20240105', TRNAMT: '-11.00', FITID: 'DC-1' }),
    '</STMTTRN></STMTTRN>',
    trn({ TRNTYPE: 'CREDIT', DTPOSTED: '20240106', TRNAMT: '22.00', FITID: 'DC-2' }),
    '</STMTTRN>',
    '</BANKTRANLIST></BANKTRANLIST>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX></OFX>',
    '',
  ].join(LF);
  text(
    '31-duplicated-closing-tags.ofx',
    ['OFXHEADER:100', 'VERSION:102', 'ENCODING:USASCII', '', ''].join(LF) + body,
  );
}

// 32 — Whole header concatenated on a single line.
{
  const header =
    'OFXHEADER:100DATA:OFXSGMLVERSION:102SECURITY:NONEENCODING:USASCIICHARSET:1252' +
    'COMPRESSION:NONEOLDFILEUID:NONENEWFILEUID:NONE' +
    CRLF +
    CRLF;
  const body = [
    '<OFX>',
    '<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>341</BANKID><ACCTID>6543219870-9</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({
      TRNTYPE: 'CREDIT',
      DTPOSTED: '20240105',
      TRNAMT: '1.111,11',
      FITID: 'OH-1',
      NAME: 'DEPOSITO',
      MEMO: 'DEPOSITO IDENTIFICADO',
    }),
    '</BANKTRANLIST><LEDGERBAL><BALAMT>1.111,11<DTASOF>20240131</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(CRLF);
  text('32-one-line-header.ofx', header + body);
}

// 33 — Empty file.
raw('33-empty.ofx', new Uint8Array(0));

// 34 — Stray closing tag that matches no open element.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>422</BANKID><ACCTID>222333444555</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({
      TRNTYPE: 'DEBIT',
      DTPOSTED: '20240105',
      TRNAMT: '-7.50',
      FITID: 'ST-1',
      MEMO: 'PAGAMENTO CONTA',
    }),
    '</NAOEXISTE>',
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text('34-stray-close-tag.ofx', MIN_HEADER() + body);
}

// 35 — Unterminated comment near EOF (the rest of the document is swallowed).
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>102</BANKID><ACCTID>123123123123</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({
      TRNTYPE: 'CREDIT',
      DTPOSTED: '20240105',
      TRNAMT: '99.00',
      FITID: 'UC-1',
      MEMO: 'RENDIMENTO APLICACAO',
    }),
    '</BANKTRANLIST><LEDGERBAL><BALAMT>99.00<DTASOF>20240131</LEDGERBAL>',
    '</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '<!-- gerado por sistema legado',
    '',
  ].join(LF);
  text('35-unterminated-comment.ofx', MIN_HEADER() + body);
}

// 36 — Bad sign-on status, no CURDEF, no ACCTID: three mapping warnings.
{
  const body = [
    '<OFX>',
    '<SIGNONMSGSRSV1><SONRS><STATUS><CODE>ABC</CODE><SEVERITY>ERROR</SEVERITY></STATUS>',
    '<DTSERVER>20240115120000[-3:BRT]</DTSERVER></SONRS></SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1><STMTTRNRS><STMTRS>',
    '<BANKACCTFROM><BANKID>260</BANKID><BRANCHID>0001</BRANCHID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({
      TRNTYPE: 'DEBIT',
      DTPOSTED: '20240105',
      TRNAMT: '-3.21',
      FITID: 'BM-1',
      MEMO: 'PAGAMENTO',
    }),
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text('36-missing-metadata.ofx', MIN_HEADER() + body);
}

// 37 — Dates with no timezone suffix: the caller's `tz` option decides.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>077</BANKID><ACCTID>555666777888</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({
      TRNTYPE: 'CREDIT',
      DTPOSTED: '20240105090000',
      TRNAMT: '10.00',
      FITID: 'TZ-1',
      MEMO: 'PIX RECEBIDO',
    }),
    trn({
      TRNTYPE: 'DEBIT',
      DTPOSTED: '20240110120000',
      TRNAMT: '-2.00',
      FITID: 'TZ-2',
      MEMO: 'PAGAMENTO',
    }),
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text('37-custom-timezone.ofx', MIN_HEADER() + body);
}

// 38 — Missing TRNTYPE/DTPOSTED, unknown TRNTYPE (sign decides) and empty NAME/MEMO.
{
  const body = [
    '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL',
    '<BANKACCTFROM><BANKID>336</BANKID><ACCTID>901234567890</ACCTID></BANKACCTFROM>',
    '<BANKTRANLIST><DTSTART>20240101<DTEND>20240131',
    trn({ DTPOSTED: '20240105', TRNAMT: '-5.00', FITID: 'MF-1' }),
    trn({ TRNTYPE: 'DEBIT', TRNAMT: '-6.00', FITID: 'MF-2', MEMO: 'PAGAMENTO' }),
    trn({
      TRNTYPE: 'XFER',
      DTPOSTED: '20240107',
      TRNAMT: '700.00',
      FITID: 'MF-3',
      NAME: 'TRANSFERENCIA',
      MEMO: 'TRANSF RECEBIDA',
    }),
    trn({
      TRNTYPE: 'XFER',
      DTPOSTED: '20240108',
      TRNAMT: '-800.00',
      FITID: 'MF-4',
      NAME: 'TRANSFERENCIA',
      MEMO: 'TRANSF ENVIADA',
    }),
    '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    '',
  ].join(LF);
  text('38-missing-optional-fields.ofx', MIN_HEADER() + body);
}

// ---------------------------------------------------------------- write out

for (const [name, bytes] of files) {
  writeFileSync(join(OUT, name), bytes);
}
console.log(`wrote ${files.size} fixtures to test/fixtures`);
for (const name of [...files.keys()].sort()) {
  console.log(`  ${name}`);
}
