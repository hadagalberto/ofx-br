/**
 * Embedded table of Brazilian financial institutions.
 *
 * Each entry carries the COMPE code (the 3-digit zero-padded bank identifier
 * used by Brazilian clearing and emitted by banks in OFX `BANKID`), the ISPB
 * (the 8-digit Identificador do Sistema de Pagamentos Brasileiro used by
 * Pix/STR) and the institution's official and short names.
 *
 * Source: Banco Central do Brasil — STR/COMPE participants list
 * (https://www.bcb.gov.br/estabilidadefinanceira/relacaoparticipantesSTR),
 * as consolidated by the BancosBrasileiros dataset
 * (https://github.com/guibranco/BancosBrasileiros, data/bancos.json),
 * retrieved on 2026-11-20. The dataset cross-checks the BCB list daily; the
 * entries below carry BCB update stamps through 2026-10. Selection: the 60+
 * institutions Brazilians actually hold accounts in — big retail banks,
 * digital banks/payment institutions, payroll lenders and cooperative
 * systems — per SPEC.md.
 */

/** One Brazilian institution from the embedded table. */
export interface BrazilianBank {
  /** COMPE code, 3 digits, zero-padded (`'001'`, `'341'`, `'748'`). */
  compe: string;
  /** ISPB — 8 digits, zero-padded (`'00000000'` for Banco do Brasil). */
  ispb: string;
  /** Official institution name. */
  name: string;
  /** Short name as registered with the BCB (`'BCO DO BRASIL S.A.'`). */
  shortName: string;
}

/** The embedded institutions, ordered by COMPE code. */
export const BRAZILIAN_BANKS: readonly BrazilianBank[] = [
  { compe: '001', ispb: '00000000', name: 'Banco do Brasil S.A.', shortName: 'BCO DO BRASIL S.A.' },
  {
    compe: '003',
    ispb: '04902979',
    name: 'Banco da Amazônia S.A.',
    shortName: 'BCO DA AMAZONIA S.A.',
  },
  {
    compe: '004',
    ispb: '07237373',
    name: 'Banco do Nordeste do Brasil S.A.',
    shortName: 'BCO DO NORDESTE DO BRASIL S.A.',
  },
  {
    compe: '007',
    ispb: '33657248',
    name: 'Banco Nacional de Desenvolvimento Econômico e Social',
    shortName: 'BNDES',
  },
  {
    compe: '021',
    ispb: '28127603',
    name: 'Banestes S.A. Banco do Estado do Espírito Santo',
    shortName: 'BCO BANESTES S.A.',
  },
  { compe: '024', ispb: '10866788', name: 'Banco Bandepe S.A.', shortName: 'BCO BANDEPE S.A.' },
  { compe: '025', ispb: '03323840', name: 'Banco Alfa S.A.', shortName: 'BCO ALFA S.A.' },
  {
    compe: '029',
    ispb: '33885724',
    name: 'Banco Itaú Consignado S.A.',
    shortName: 'BANCO ITAÚ CONSIGNADO S.A.',
  },
  {
    compe: '033',
    ispb: '90400888',
    name: 'Banco Santander (Brasil) S.A.',
    shortName: 'BCO SANTANDER (BRASIL) S.A.',
  },
  { compe: '036', ispb: '06271464', name: 'Banco Bradesco BBI S.A.', shortName: 'BCO BBI S.A.' },
  {
    compe: '037',
    ispb: '04913711',
    name: 'Banco do Estado do Pará S.A.',
    shortName: 'BCO DO EST. DO PA S.A.',
  },
  {
    compe: '041',
    ispb: '92702067',
    name: 'Banco do Estado do Rio Grande do Sul S.A.',
    shortName: 'BCO DO ESTADO DO RS S.A.',
  },
  {
    compe: '047',
    ispb: '13009717',
    name: 'Banco do Estado de Sergipe S.A.',
    shortName: 'BCO DO EST. DE SE S.A.',
  },
  {
    compe: '062',
    ispb: '03012230',
    name: 'Hipercard Banco Múltiplo S.A.',
    shortName: 'HIPERCARD BM S.A.',
  },
  {
    compe: '070',
    ispb: '00000208',
    name: 'BRB - Banco de Brasília S.A.',
    shortName: 'BRB - BCO DE BRASILIA S.A.',
  },
  { compe: '077', ispb: '00416968', name: 'Banco Inter S.A.', shortName: 'BANCO INTER' },
  {
    compe: '085',
    ispb: '05463212',
    name: 'Cooperativa Central de Crédito - Ailos',
    shortName: 'COOPCENTRAL AILOS',
  },
  {
    compe: '091',
    ispb: '01634601',
    name: 'Central de Cooperativas de Economia e Crédito Mútuo do Estado do Rio Grande do Sul',
    shortName: 'CCCM UNICRED CENTRAL RS',
  },
  {
    compe: '102',
    ispb: '02332886',
    name: 'XP Investimentos Corretora de Câmbio, Títulos e Valores Mobiliários S/A',
    shortName: 'XP INVESTIMENTOS CCTVM S/A',
  },
  {
    compe: '104',
    ispb: '00360305',
    name: 'Caixa Econômica Federal',
    shortName: 'CAIXA ECONOMICA FEDERAL',
  },
  { compe: '121', ispb: '10664513', name: 'Banco Agibank S.A.', shortName: 'BCO AGIBANK S.A.' },
  {
    compe: '124',
    ispb: '15357060',
    name: 'Banco Woori Bank do Brasil S.A.',
    shortName: 'BCO WOORI BANK DO BRASIL S.A.',
  },
  { compe: '125', ispb: '45246410', name: 'Banco Genial S.A.', shortName: 'BANCO GENIAL' },
  {
    compe: '133',
    ispb: '10398952',
    name: 'Confederação Nacional das Cooperativas Centrais de Crédito e Economia Familiar e Solidária - Cresol',
    shortName: 'CRESOL CONFEDERAÇÃO',
  },
  {
    compe: '136',
    ispb: '00315557',
    name: 'Cooperativa Central de Crédito Unicred do Brasil - Unicred do Brasil',
    shortName: 'UNICRED DO BRASIL',
  },
  { compe: '184', ispb: '17298092', name: 'Banco Itaú BBA S.A.', shortName: 'BCO ITAÚ BBA S.A.' },
  {
    compe: '197',
    ispb: '16501555',
    name: 'Stone Instituição de Pagamento S.A.',
    shortName: 'STONE IP S.A.',
  },
  {
    compe: '208',
    ispb: '30306294',
    name: 'Banco BTG Pactual S.A.',
    shortName: 'BANCO BTG PACTUAL S.A.',
  },
  { compe: '212', ispb: '92894922', name: 'Banco Original S.A.', shortName: 'BANCO ORIGINAL' },
  { compe: '224', ispb: '58616418', name: 'Banco Fibra S.A.', shortName: 'BCO FIBRA S.A.' },
  { compe: '237', ispb: '60746948', name: 'Banco Bradesco S.A.', shortName: 'BCO BRADESCO S.A.' },
  {
    compe: '246',
    ispb: '28195667',
    name: 'Banco ABC Brasil S.A.',
    shortName: 'BCO ABC BRASIL S.A.',
  },
  { compe: '254', ispb: '14388334', name: 'Paraná Banco S.A.', shortName: 'PARANA BCO S.A.' },
  {
    compe: '260',
    ispb: '18236120',
    name: 'Nu Pagamentos S.A. - Instituição de Pagamento',
    shortName: 'NU PAGAMENTOS - IP',
  },
  {
    compe: '290',
    ispb: '08561701',
    name: 'Pagseguro Internet Instituição de Pagamento S.A.',
    shortName: 'PAGSEGURO INTERNET IP S.A.',
  },
  { compe: '318', ispb: '61186680', name: 'Banco BMG S.A.', shortName: 'BCO BMG S.A.' },
  {
    compe: '323',
    ispb: '10573521',
    name: 'Mercado Pago Instituição de Pagamento Ltda.',
    shortName: 'MERCADO PAGO IP LTDA.',
  },
  {
    compe: '330',
    ispb: '00556603',
    name: 'Banco Bari de Investimentos e Financiamentos S.A.',
    shortName: 'BANCO BARI S.A.',
  },
  {
    compe: '332',
    ispb: '13140088',
    name: 'Acesso Soluções de Pagamento S.A. - Instituição de Pagamento',
    shortName: 'ACESSO SOLUÇÕES DE PAGAMENTO S.A. - IP',
  },
  { compe: '335', ispb: '27098060', name: 'Banco Digio S.A.', shortName: 'BANCO DIGIO' },
  { compe: '336', ispb: '31872495', name: 'Banco C6 S.A.', shortName: 'BCO C6 S.A.' },
  { compe: '341', ispb: '60701190', name: 'Itaú Unibanco S.A.', shortName: 'ITAÚ UNIBANCO S.A.' },
  { compe: '348', ispb: '33264668', name: 'Banco XP S.A.', shortName: 'BCO XP S.A.' },
  {
    compe: '380',
    ispb: '22896431',
    name: 'PicPay Instituição de Pagamento S.A.',
    shortName: 'PICPAY',
  },
  {
    compe: '389',
    ispb: '17184037',
    name: 'Banco Mercantil do Brasil S.A.',
    shortName: 'BCO MERCANTIL DO BRASIL S.A.',
  },
  {
    compe: '394',
    ispb: '07207996',
    name: 'Banco Bradesco Financiamentos S.A.',
    shortName: 'BCO BRADESCO FINANC. S.A.',
  },
  {
    compe: '403',
    ispb: '37880206',
    name: 'Cora Sociedade de Crédito, Financiamento e Investimento S.A.',
    shortName: 'CORA SCFI',
  },
  { compe: '422', ispb: '58160789', name: 'Banco Safra S.A.', shortName: 'BCO SAFRA S.A.' },
  {
    compe: '461',
    ispb: '19540550',
    name: 'Asaas Gestão Financeira Instituição de Pagamento S.A.',
    shortName: 'ASAAS IP S.A.',
  },
  { compe: '477', ispb: '33042953', name: 'Citibank N.A.', shortName: 'CITIBANK N.A.' },
  {
    compe: '536',
    ispb: '20855875',
    name: 'Neon Pagamentos S.A. - Instituição de Pagamento',
    shortName: 'NEON PAGAMENTOS S.A. IP',
  },
  {
    compe: '555',
    ispb: '02682287',
    name: 'Pan Financeira S.A. - Sociedade de Crédito, Financiamento e Investimento',
    shortName: 'PAN FINAN',
  },
  {
    compe: '595',
    ispb: '19468242',
    name: 'iFood Pago Instituição de Pagamento S.A.',
    shortName: 'IFOOD PAGO IP',
  },
  { compe: '610', ispb: '78626983', name: 'Banco VR S.A.', shortName: 'BCO VR S.A.' },
  { compe: '623', ispb: '59285411', name: 'Banco Pan S.A.', shortName: 'BANCO PAN' },
  {
    compe: '633',
    ispb: '68900810',
    name: 'Banco Rendimento S.A.',
    shortName: 'BCO RENDIMENTO S.A.',
  },
  { compe: '634', ispb: '17351180', name: 'Banco Triângulo S.A.', shortName: 'BCO TRIANGULO S.A.' },
  { compe: '637', ispb: '60889128', name: 'Banco Sofisa S.A.', shortName: 'BCO SOFISA S.A.' },
  {
    compe: '655',
    ispb: '59588111',
    name: 'Banco Votorantim S.A. (BV)',
    shortName: 'BCO VOTORANTIM S.A.',
  },
  { compe: '707', ispb: '62232889', name: 'Banco Daycoval S.A.', shortName: 'BCO DAYCOVAL S.A.' },
  { compe: '739', ispb: '00558456', name: 'Banco Cetelem S.A.', shortName: 'BCO CETELEM S.A.' },
  { compe: '746', ispb: '30723886', name: 'Banco Modal S.A.', shortName: 'BCO MODAL S.A.' },
  {
    compe: '747',
    ispb: '01023570',
    name: 'Banco Rabobank International Brasil S.A.',
    shortName: 'BCO RABOBANK INTL BRASIL S.A.',
  },
  {
    compe: '748',
    ispb: '01181521',
    name: 'Banco Cooperativo Sicredi S.A.',
    shortName: 'BANCO COOPERATIVO SICREDI',
  },
  {
    compe: '756',
    ispb: '02038232',
    name: 'Banco Cooperativo Sicoob S.A. - Banco Sicoob',
    shortName: 'BANCO SICOOB S.A.',
  },
];

/** COMPE code (`'341'`) → bank. */
const BY_COMPE: ReadonlyMap<string, BrazilianBank> = new Map(
  BRAZILIAN_BANKS.map((b) => [b.compe, b]),
);

/** ISPB (`'60701190'`) → bank. */
const BY_ISPB: ReadonlyMap<string, BrazilianBank> = new Map(
  BRAZILIAN_BANKS.map((b) => [b.ispb, b]),
);

/**
 * Resolves a bank by its COMPE code, as emitted in OFX `BANKID`:
 * `'341'`, `'41'` and `' 341 '` all resolve (1–3 digits are zero-padded).
 * Longer or non-numeric values resolve to `undefined`.
 */
export function resolveBankByCompe(code: string): BrazilianBank | undefined {
  const trimmed = code.trim();
  if (!/^\d{1,3}$/.test(trimmed)) {
    return undefined;
  }
  return BY_COMPE.get(trimmed.padStart(3, '0'));
}

/** Resolves a bank by its 8-digit ISPB (`'60701190'`). */
export function resolveBankByIspb(ispb: string): BrazilianBank | undefined {
  const trimmed = ispb.trim();
  if (!/^\d{8}$/.test(trimmed)) {
    return undefined;
  }
  return BY_ISPB.get(trimmed);
}

/**
 * Resolves a bank from an OFX `BANKID`: a 1–3 digit value is a COMPE code
 * (zero-padded, per SPEC), an 8 digit value is an ISPB. Anything else (foreign
 * banks, garbage) resolves to `undefined`.
 */
export function resolveBank(id: string): BrazilianBank | undefined {
  return resolveBankByCompe(id) ?? resolveBankByIspb(id);
}

/**
 * Normalizes an OFX `BANKID` for the normalized model: 1–3 digit numeric
 * values become the zero-padded COMPE code (`'341'`, `'41'` → `'041'`);
 * anything else is kept verbatim (trimmed).
 */
export function normalizeBankId(id: string): string {
  const trimmed = id.trim();
  if (/^\d{1,3}$/.test(trimmed)) {
    return trimmed.padStart(3, '0');
  }
  return trimmed;
}
