import dotenv from 'dotenv';

dotenv.config();

const firstNonEmpty = (...values) =>
  values.map((v) => (v == null ? '' : String(v).trim())).find((v) => v !== '');

const normalizeBearer = (token) =>
  token && !/^Bearer\s+/i.test(token) ? `Bearer ${token}` : token;

const parseOptionalBool = (raw) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
  return !/^(off|false|0|no)$/i.test(String(raw).trim());
};

export const config = {
  port: parseInt(process.env.PORT || '2021', 10),
  auth: {
    username: process.env.APP_USERNAME || 'admin',
    password: process.env.APP_PASSWORD || 'admin123',
  },
  emr: {
    loginUrl: process.env.EMR_LOGIN_URL,
    labUrlTemplate: process.env.EMR_LAB_URL_TEMPLATE,
    queryBuilderUrl: process.env.EMR_QUERY_BUILDER_URL,
    retDatatableUrl: process.env.EMR_RET_DATATABLE_URL || 'https://emr.mapims.edu.in/BB15SE/Lab/wsLabServices.asmx/RETDatatable',
    username: process.env.EMR_USERNAME,
    password: process.env.EMR_PASSWORD,
    logOpt: process.env.EMR_LOG_OPT || '2',
  },
  hospital: {
    logoPath: process.env.HOSPITAL_LOGO_PATH,
    nameEn: process.env.HOSPITAL_NAME_EN,
    nameTa: process.env.HOSPITAL_NAME_TA,
    address: process.env.HOSPITAL_ADDRESS,
  },
  wati: {
    // Prefer root .env WATI_* overrides when non-empty; fall back to server/.env keys.
    endpoint: firstNonEmpty(process.env.WATI_URL, process.env.API_ENDPOINT)?.replace(/\/+$/, ''),
    // Root .env may pass a bare JWT (`WATI_TOKEN`) while server/.env passes `Bearer <jwt>`.
    accessToken: normalizeBearer(firstNonEmpty(process.env.WATI_TOKEN, process.env.WATI_ACCESS_TOKEN)),
    templateId: firstNonEmpty(process.env.WATI_TEMPLATE_NAME, process.env.WATI_TEMPLATE_ID) || 'mapims_lab_rpt',
    testPhone: firstNonEmpty(process.env.WATI_TEST_PHONE),
    sendEnabled: parseOptionalBool(process.env.WATI_SEND_ENABLED),
    testMode: parseOptionalBool(process.env.WATI_TEST_MODE),
  },
  // Used by Ask AI assistantService.js as Gemini fallback if enabled
  gemini: {
    apiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  },
};
