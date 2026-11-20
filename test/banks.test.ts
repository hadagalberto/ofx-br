/**
 * The embedded Brazilian bank table (SPEC.md "Bank name resolution"):
 * integrity of the table itself (shape, uniqueness, ≥ 60 institutions) and
 * COMPE/ISPB resolution from the shapes real OFX `BANKID` values take.
 */
import { describe, expect, it } from 'vitest';
import {
  BRAZILIAN_BANKS,
  normalizeBankId,
  resolveBank,
  resolveBankByCompe,
  resolveBankByIspb,
} from '../src/index.js';

describe('BRAZILIAN_BANKS table integrity', () => {
  it('has at least the 60 most common institutions', () => {
    expect(BRAZILIAN_BANKS.length).toBeGreaterThanOrEqual(60);
  });

  it('every entry carries a 3-digit zero-padded COMPE code, an 8-digit ISPB and names', () => {
    for (const bank of BRAZILIAN_BANKS) {
      expect(bank.compe).toMatch(/^\d{3}$/);
      expect(bank.ispb).toMatch(/^\d{8}$/);
      expect(bank.name.length).toBeGreaterThan(3);
      expect(bank.shortName.length).toBeGreaterThan(1);
    }
  });

  it('COMPE codes are unique and sorted', () => {
    const codes = BRAZILIAN_BANKS.map((bank) => bank.compe);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(codes);
  });

  it('ISPBs are unique', () => {
    const ispbs = BRAZILIAN_BANKS.map((bank) => bank.ispb);
    expect(new Set(ispbs).size).toBe(ispbs.length);
  });

  it('contains the institutions the SPEC mandates by name', () => {
    const byCompe = new Map(BRAZILIAN_BANKS.map((bank) => [bank.compe, bank]));
    const required: readonly (readonly [string, RegExp])[] = [
      ['001', /Banco do Brasil/i],
      ['004', /Nordeste/i],
      ['021', /Banestes/i],
      ['033', /Santander/i],
      ['041', /Rio Grande do Sul/i], // Banrisul
      ['070', /Bras[íi]lia/i], // BRB
      ['077', /Inter/i],
      ['102', /XP/i],
      ['104', /Caixa/i],
      ['197', /Stone/i],
      ['208', /BTG/i],
      ['212', /Original/i],
      ['237', /Bradesco/i],
      ['260', /Nu Pagamentos/i],
      ['290', /Pagseguro/i],
      ['323', /Mercado Pago/i],
      ['336', /C6/i],
      ['341', /Ita[úu]/i],
      ['380', /PicPay/i],
      ['403', /Cora/i],
      ['422', /Safra/i],
      ['655', /Votorantim/i],
      ['748', /Sicredi/i],
      ['756', /Sicoob/i],
    ];
    for (const [compe, pattern] of required) {
      expect(byCompe.get(compe)?.name, `COMPE ${compe}`).toMatch(pattern);
    }
  });
});

describe('resolveBankByCompe', () => {
  it('resolves zero-padded, unpadded and padded COMPE codes', () => {
    expect(resolveBankByCompe('341')?.shortName).toBe('ITAÚ UNIBANCO S.A.');
    expect(resolveBankByCompe('41')?.shortName).toBe('BCO DO ESTADO DO RS S.A.');
    expect(resolveBankByCompe('1')?.name).toBe('Banco do Brasil S.A.');
    expect(resolveBankByCompe('001')?.ispb).toBe('00000000');
    expect(resolveBankByCompe(' 077 ')?.name).toBe('Banco Inter S.A.');
    expect(resolveBankByCompe('260')?.name).toBe('Nu Pagamentos S.A. - Instituição de Pagamento');
    expect(resolveBankByCompe('748')?.name).toContain('Sicredi');
    expect(resolveBankByCompe('756')?.name).toContain('Sicoob');
    expect(resolveBankByCompe('104')?.name).toBe('Caixa Econômica Federal');
  });

  it('returns undefined for unknown or malformed codes', () => {
    expect(resolveBankByCompe('999')).toBeUndefined();
    expect(resolveBankByCompe('')).toBeUndefined();
    expect(resolveBankByCompe('abc')).toBeUndefined();
    expect(resolveBankByCompe('3411')).toBeUndefined(); // 4 digits: not a COMPE lookup
    expect(resolveBankByCompe('-34')).toBeUndefined();
  });
});

describe('resolveBankByIspb', () => {
  it('resolves 8-digit ISPBs', () => {
    expect(resolveBankByIspb('60701190')?.shortName).toBe('ITAÚ UNIBANCO S.A.');
    expect(resolveBankByIspb('18236120')?.name).toContain('Nu Pagamentos');
    expect(resolveBankByIspb('00000000')?.name).toBe('Banco do Brasil S.A.');
    expect(resolveBankByIspb(' 01181521 ')?.name).toContain('Sicredi');
  });

  it('returns undefined for malformed ISPBs', () => {
    expect(resolveBankByIspb('6070119')).toBeUndefined();
    expect(resolveBankByIspb('6070119 ')).toBeUndefined();
    expect(resolveBankByIspb('abcdefgh')).toBeUndefined();
    expect(resolveBankByIspb('99999999')).toBeUndefined();
  });
});

describe('resolveBank (BANKID semantics)', () => {
  it('resolves COMPE first, then ISPB', () => {
    expect(resolveBank('341')?.compe).toBe('341');
    expect(resolveBank('41')?.compe).toBe('041');
    expect(resolveBank('60701190')?.compe).toBe('341'); // ISPB fallback
    expect(resolveBank('02038232')?.shortName).toBe('BANCO SICOOB S.A.');
    expect(resolveBank('90400888')?.shortName).toBe('BCO SANTANDER (BRASIL) S.A.');
  });

  it('returns undefined for anything else (foreign banks, garbage)', () => {
    expect(resolveBank('')).toBeUndefined();
    expect(resolveBank('XXX')).toBeUndefined();
    expect(resolveBank('1234')).toBeUndefined();
    expect(resolveBank('1234567890123')).toBeUndefined();
  });
});

describe('normalizeBankId', () => {
  it.each([
    ['341', '341'],
    ['41', '041'],
    ['1', '001'],
    [' 748 ', '748'],
    ['3410', '3410'], // longer ids stay verbatim
    ['BANCO', 'BANCO'],
    ['', ''],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeBankId(raw)).toBe(expected);
  });
});
