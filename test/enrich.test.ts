/**
 * Memo enrichment (SPEC.md "Transaction enrichment" + "Credit card"):
 * category detection (case/accent-insensitive pt-BR), counterparty and
 * CPF/CNPJ extraction (masked forms included), installments, and the
 * credit-card sign convention — at the unit level, through the exported
 * helpers. All names/documents are synthetic; the CPF/CNPJ test values are
 * valid-but-fake (123.456.789-09, 111.444.777-35, 00.000.000/0001-91,
 * 11.222.333/0001-81).
 */
import { describe, expect, it } from 'vitest';
import {
  detectInstallment,
  detectMemoCategory,
  enrichMemo,
  enrichTransaction,
  extractCounterparty,
} from '../src/index.js';
import type { Transaction } from '../src/index.js';

describe('detectMemoCategory', () => {
  it.each([
    // pix — whole word, any case/accents, anywhere in the memo
    ['pix', 'pix'],
    ['Pix enviado', 'pix'],
    ['PIX RECEBIDO', 'pix'],
    ['Transferência via Pix', 'pix'],
    ['chave PIX JOAO', 'pix'],
    // ted / doc — whole word only
    ['TED 260 NU PAGAMENTOS', 'ted'],
    ['Recebimento TED', 'ted'],
    ['ted', 'ted'],
    ['DOC 001', 'doc'],
    ['Pagamento DOC', 'doc'],
    ['doc', 'doc'],
    // boleto — substring, catches squashed labels
    ['PAGAMENTO DE BOLETO', 'boleto'],
    ['Boleto pago', 'boleto'],
    ['PGBOLETO COMPANHIA', 'boleto'],
    // tarifa / iof / juros
    ['TARIFA MENSAL', 'tarifa'],
    ['Tarifas bancárias', 'tarifa'],
    ['IOF COMPRA INTERNACIONAL', 'iof'],
    ['iof', 'iof'],
    ['JUROS', 'juros'],
    ['Juros de mora', 'juros'],
    ['CRÉDITO JUROS POUPANÇA', 'juros'],
    // estorno / saque
    ['ESTORNO', 'estorno'],
    ['Estorno de PIX', 'estorno'],
    ['Compra estornada', 'estorno'],
    ['SAQUE CAIXA 24H', 'saque'],
    ['Saque dinheiro', 'saque'],
    // card purchase / transfer
    ['COMPRA CARTÃO', 'card-purchase'],
    ['Compras', 'card-purchase'],
    ['Compra parcelada', 'card-purchase'],
    ['compra no débito', 'card-purchase'],
    ['TRANSFERENCIA', 'transfer'],
    ['Transferência entre contas', 'transfer'],
    ['TRANSF ONLINE', 'transfer'],
    ['Transferido da conta', 'transfer'],
  ])('%s → %s', (memo, expected) => {
    expect(detectMemoCategory(memo)).toBe(expected);
  });

  it('is accent- and case-insensitive in every combination', () => {
    expect(detectMemoCategory('Éstôrnô dê cômprà çàrtãô')).toBe('estorno');
    expect(detectMemoCategory('Tàrïfá MÉNSÃL')).toBe('tarifa');
    expect(detectMemoCategory('trÅnsfêrêncïà õnlïnê')).toBe('transfer');
    expect(detectMemoCategory('cômprà çàrtãõ')).toBe('card-purchase');
  });

  it.each([
    ['SALARIO MAIO', 'salary is not a category'],
    ['DEPOSITO EM DINHEIRO', 'deposit is not a category'],
    ['PAGAMENTO FATURA', 'card-bill payment is not a purchase'],
    ['DOCX FEE', 'DOCX is not the DOC operation'],
    ['CREDITADO', 'no whole-word ted/doc/pix hiding inside'],
    ['COMPRACARTAO', 'squashed word is not a whole word'],
    ['PIXCOB', 'squashed word is not a whole word'],
    ['', 'empty memo'],
  ])('%s → undefined (%s)', (memo) => {
    expect(detectMemoCategory(memo)).toBeUndefined();
  });

  it('applies the documented priority when several keywords match', () => {
    expect(detectMemoCategory('ESTORNO PIX RECEBIDO')).toBe('estorno'); // refund beats all
    expect(detectMemoCategory('TARIFA DE TED')).toBe('tarifa'); // fee beats its operation
    expect(detectMemoCategory('TARIFA MENSAL SAQUE')).toBe('tarifa');
    expect(detectMemoCategory('IOF SOBRE COMPRA CARTÃO')).toBe('iof');
    expect(detectMemoCategory('JUROS PIX')).toBe('juros');
    expect(detectMemoCategory('SAQUE PIX 24H')).toBe('saque');
    expect(detectMemoCategory('PIX BOLETO')).toBe('pix'); // pix beats boleto/compra
    expect(detectMemoCategory('TED TRANSFERENCIA')).toBe('ted');
    expect(detectMemoCategory('DOC TRANSFERENCIA')).toBe('doc');
    expect(detectMemoCategory('BOLETO TRANSFERENCIA')).toBe('boleto');
    expect(detectMemoCategory('COMPRAS TRANSF')).toBe('card-purchase');
  });
});

describe('detectInstallment', () => {
  it.each([
    ['PARC 02/10', { current: 2, total: 10 }],
    ['Compra cartão PARC 02/10', { current: 2, total: 10 }],
    ['parc02/10', { current: 2, total: 10 }], // squashed
    ['parcela 3/6', { current: 3, total: 6 }],
    ['PARCELAMENTO 05/12', { current: 5, total: 12 }],
    ['PARCELADA 04/08', { current: 4, total: 8 }],
    ['Compra Parcelada (PARC 01/24)', { current: 1, total: 24 }],
    ['pagamento parc - 7/36', { current: 7, total: 36 }],
  ])('%s → %s', (memo, expected) => {
    expect(detectInstallment(memo)).toEqual(expected);
  });

  it.each([
    ['02/10', 'no keyword: a date fragment is not an installment'],
    ['VENCIMENTO 02/10/2024', 'dates are not installments'],
    ['PAGAMENTO PARCIAL 02/10', '"parcial" is not a "parc" keyword'],
    ['PARC 1/1', 'a single installment is not a plan'],
    ['PARC 0/10', 'zeroth installment is invalid'],
    ['PARC 12/10', 'current may not exceed total'],
    ['PARC 02/60', 'implausible totals beyond 48 are noise'],
    ['PARC 2/100', 'more than two digits is not an installment'],
    ['SALARIO', 'nothing to detect'],
    ['', 'empty memo'],
  ])('%s → undefined (%s)', (memo) => {
    expect(detectInstallment(memo)).toBeUndefined();
  });
});

describe('extractCounterparty', () => {
  it.each([
    // The two canonical SPEC patterns
    ['Pix enviado - FULANO', { name: 'FULANO' }],
    ['Pix enviado - FULANO DE TAL', { name: 'FULANO DE TAL' }],
    ['TRANSF RECEBIDO CPF 123.456.789-09', { document: '123.456.789-09' }],
    // Names, with case/accents anywhere and accents preserved in the result
    ['PIX ENVIADO PARA MARIA DA SILVA', { name: 'MARIA DA SILVA' }],
    ['Pix recebido de José Mário', { name: 'José Mário' }],
    ['Pix Enviado Pix Enviado - FULANO', { name: 'FULANO' }], // repeated bank label
    ['TED EMPRESA X', { name: 'EMPRESA X' }],
    ['TRANSFERENCIA PARA JOAO', { name: 'JOAO' }],
    ['BOLETO PAGO COMPANHIA ALFA', { name: 'COMPANHIA ALFA' }],
    ['PAGAMENTO DE BOLETO COMPANHIA ENERGETICA', { name: 'COMPANHIA ENERGETICA' }],
    ['compra cartão MERCADO LIVRE', { name: 'MERCADO LIVRE' }],
    ['Compra no cartão PADARIA DO ZÉ', { name: 'PADARIA DO ZÉ' }],
    ['pix enviado aplicação josé', { name: 'josé' }],
    // Documents: full, masked and bare-keyword forms
    [
      'Pix enviado - JOAO SILVA - CPF 123.456.789-09',
      { name: 'JOAO SILVA', document: '123.456.789-09' },
    ],
    [
      'Pix recebido - MARIA SOUZA - CPF ***.123.456-**',
      { name: 'MARIA SOUZA', document: '***.123.456-**' },
    ],
    [
      'TED BANCO DO BRASIL CNPJ 00.000.000/0001-91',
      { name: 'BANCO DO BRASIL', document: '00.000.000/0001-91' },
    ],
    ['DOC ENVIADO - CNPJ: 11.222.333/0001-81', { document: '11.222.333/0001-81' }],
    ['PIX ***.***.789-**', { document: '***.***.789-**' }],
    ['TRANSF CNPJ 12345678000195', { document: '12345678000195' }],
    ['CPF 12345678909 SEM OUTRA COISA', { document: '12345678909' }],
  ])('%s → %s', (memo, expected) => {
    expect(extractCounterparty(memo)).toEqual(expected);
  });

  it('uses the NAME leaf for card statements whose memo is only the label', () => {
    expect(
      extractCounterparty('Compra cartão', { name: 'MERCADO LIVRE', kind: 'creditcard' }),
    ).toEqual({
      name: 'MERCADO LIVRE',
    });
    // But a label-only NAME is not a counterparty
    expect(
      extractCounterparty('Compra cartão', { name: 'Compra cartão', kind: 'creditcard' }),
    ).toBeUndefined();
    expect(
      extractCounterparty('PAGAMENTO RECEBIDO', { name: 'Pagamento recebido', kind: 'creditcard' }),
    ).toBeUndefined();
    // Bank statements never fall back to NAME
    expect(
      extractCounterparty('Compra cartão', { name: 'MERCADO LIVRE', kind: 'bank' }),
    ).toBeUndefined();
  });

  it.each([
    ['TARIFA MENSAL', 'fees carry no counterparty'],
    ['IOF COMPRA INTERNACIONAL', 'fees carry no counterparty'],
    ['JUROS CREDITADOS', 'interest carries no counterparty'],
    ['SAQUE CAIXA 24H', 'withdrawals carry no counterparty'],
    ['DOC RECEBIDO', 'label-only memo'],
    ['PAGAMENTO BOLETO', 'label-only memo'],
    ['PIX ENVIADO R$ 100,00 FULANO', 'leftover amounts are not names'],
    ['TED 0012 BANCO BRASIL', 'candidates must start with a letter'],
    ['PIX ***.***.***-**', 'fully masked document identifies nobody'],
    ['TED 1123.456.789-01 EMPRESA', 'a digit glued before the token is not a CPF'],
    ['PIX RECEBIDO 123.456.789-012', 'a digit glued after the token is not a CPF'],
    ['PIX RECEBIDO VIA APP', 'trailing channel labels are not names'],
    ['COMPRA CARTAO & PIX 0', 'noise is not a name'],
    ['SALARIO MAIO', 'nothing to extract'],
    ['', 'empty memo'],
  ])('%s → undefined (%s)', (memo) => {
    expect(extractCounterparty(memo)).toBeUndefined();
  });
});

describe('enrichMemo', () => {
  it('combines category, counterparty and installment in one pass', () => {
    expect(
      enrichMemo('COMPRA CARTAO PARC 02/10', { name: 'PADARIA PÃO DOCE', kind: 'creditcard' }),
    ).toEqual({
      category: 'card-purchase',
      counterparty: { name: 'PADARIA PÃO DOCE' },
      installment: { current: 2, total: 10 },
    });
    expect(enrichMemo('Pix recebido - MARIA SOUZA - CPF ***.123.456-**')).toEqual({
      category: 'pix',
      counterparty: { name: 'MARIA SOUZA', document: '***.123.456-**' },
    });
    expect(enrichMemo('TARIFA DE TED')).toEqual({ category: 'tarifa' });
    expect(enrichMemo('SALARIO MAIO')).toEqual({});
    expect(enrichMemo('')).toEqual({});
  });
});

describe('enrichTransaction — credit-card sign normalization', () => {
  /** A minimal transaction for direct enrichment, as `parse` would build it. */
  function tx(fields: {
    type?: string;
    cents: number;
    description: string;
    name?: string;
  }): Transaction {
    const type = fields.type ?? 'OTHER';
    const upperType = type.toUpperCase();
    // Same rule the mapping applies: TRNTYPE decides, the amount sign falls back.
    const direction =
      upperType === 'DEBIT'
        ? ('debit' as const)
        : upperType === 'CREDIT'
          ? ('credit' as const)
          : fields.cents < 0
            ? ('debit' as const)
            : ('credit' as const);
    const transaction: Transaction = {
      id: 'x1',
      type,
      direction,
      amount: { cents: BigInt(fields.cents), currency: 'BRL' },
      postedAt: '2024-01-01T12:00:00-03:00',
      description: fields.description,
    };
    if (fields.name !== undefined) {
      transaction.name = fields.name;
    }
    return transaction;
  }

  it('flips positive purchases to negative debits', () => {
    const purchase = tx({ type: 'DEBIT', cents: 13790, description: 'COMPRA CARTAO PARC 02/10' });
    enrichTransaction(purchase, 'creditcard');
    expect(purchase.amount.cents).toBe(-13790n);
    expect(purchase.direction).toBe('debit');
    expect(purchase.category).toBe('card-purchase');
    expect(purchase.installment).toEqual({ current: 2, total: 10 });
  });

  it('lets a detected purchase outrank a mislabelled TRNTYPE', () => {
    const purchase = tx({ type: 'OTHER', cents: 2000, description: 'COMPRA CARTAO MERCADO LIVRE' });
    enrichTransaction(purchase, 'creditcard');
    expect(purchase.amount.cents).toBe(-2000n);
    expect(purchase.direction).toBe('debit');
    expect(purchase.counterparty).toEqual({ name: 'MERCADO LIVRE' });
  });

  it('flips negative refunds to positive credits (estorno outranks TRNTYPE)', () => {
    const refund = tx({ type: 'CREDIT', cents: -2500, description: 'ESTORNO DE COMPRA' });
    enrichTransaction(refund, 'creditcard');
    expect(refund.amount.cents).toBe(2500n);
    expect(refund.direction).toBe('credit');
    expect(refund.category).toBe('estorno');
  });

  it.each([
    [
      'keeps already-negative purchases untouched',
      { type: 'DEBIT', cents: -5000, description: 'COMPRA' },
    ],
    [
      'keeps already-positive credits untouched',
      { type: 'CREDIT', cents: 150000, description: 'PAGAMENTO RECEBIDO' },
    ],
    ['keeps zero untouched', { type: 'CREDIT', cents: 0, description: 'PAGAMENTO RECEBIDO' }],
    [
      'leaves rows without an unambiguous intent alone',
      { type: 'XFER', cents: 10000, description: 'PIX ENVIADO' },
    ],
  ])('%s', (_name, fields) => {
    const before = tx(fields);
    enrichTransaction(before, 'creditcard');
    expect(before.amount.cents).toBe(BigInt(fields.cents));
    expect(before.direction).toBe(fields.cents < 0 ? 'debit' : 'credit');
  });

  it('never rewrites bank-statement amounts', () => {
    const refund = tx({ type: 'CREDIT', cents: -1000, description: 'ESTORNO DE DEBITO' });
    enrichTransaction(refund, 'bank');
    expect(refund.amount.cents).toBe(-1000n);
    expect(refund.category).toBe('estorno'); // enrichment still applies
    expect(refund.direction).toBe('credit'); // direction from TRNTYPE, as emitted

    const purchase = tx({ type: 'DEBIT', cents: 13790, description: 'COMPRA CARTÃO' });
    enrichTransaction(purchase, 'bank');
    expect(purchase.amount.cents).toBe(13790n);
    expect(purchase.direction).toBe('debit');
    expect(purchase.category).toBe('card-purchase');
  });

  it('fills nothing on empty descriptions', () => {
    const empty = tx({ type: 'DEBIT', cents: -100, description: '' });
    enrichTransaction(empty, 'creditcard');
    expect(empty.category).toBeUndefined();
    expect(empty.counterparty).toBeUndefined();
    expect(empty.installment).toBeUndefined();
    expect(empty.amount.cents).toBe(-100n);
  });
});
