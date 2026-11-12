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

const deriveEmrLoginUrl = (url) => {
  const match = String(url || '').match(/^(https?:\/\/[^?#]+?)\/(?:QueryBuilder|Lab)\//i);
  return match ? `${match[1]}/wsLogin.asmx/chkLoginNew` : undefined;
};

const formatEmrLabUrlTemplate = (url) => {
  const clean = String(url || '').trim();
  if (!clean) return undefined;
  return clean.includes('Orderid=') ? clean : `${clean}${clean.includes('?') ? '&' : '?'}action=Search&Orderid=`;
};

const queryBuilderUrl = firstNonEmpty(process.env.EMR_QUERY_BUILDER_URL, process.env.ROOT_EMR_QUERY_BUILDER_URL);
const labResultHisUrl = firstNonEmpty(process.env.EMR_LAB_URL_TEMPLATE, process.env.ROOT_EMR_LAB_URL_TEMPLATE);

export const config = {
  port: parseInt(process.env.PORT || '2021', 10),
  auth: {
    username: process.env.APP_USERNAME || 'admin',
    password: process.env.APP_PASSWORD || 'admin123',
  },
  emr: {
    loginUrl:
      firstNonEmpty(process.env.EMR_LOGIN_URL, process.env.ROOT_EMR_LOGIN_URL) ||
      deriveEmrLoginUrl(firstNonEmpty(process.env.ROOT_EMR_REPORT_BASE_URL, process.env.ROOT_EMR_LAB_RESULT_HIS_URL, queryBuilderUrl)),
    labUrlTemplate: labResultHisUrl || formatEmrLabUrlTemplate(process.env.ROOT_EMR_LAB_RESULT_HIS_URL),
    queryBuilderUrl,
    retDatatableUrl:
      firstNonEmpty(process.env.EMR_RET_DATATABLE_URL, process.env.ROOT_EMR_RET_DATATABLE_URL, process.env.ROOT_EMR_LAB_SERVICES_URL) ||
      'https://emr.mapims.edu.in/BB15SE/Lab/wsLabServices.asmx/RETDatatable',
    username: firstNonEmpty(process.env.EMR_USERNAME, process.env.ROOT_EMR_USERNAME),
    password: firstNonEmpty(process.env.EMR_PASSWORD, process.env.ROOT_EMR_PASSWORD),
    logOpt: firstNonEmpty(process.env.EMR_LOG_OPT, process.env.ROOT_EMR_LOG_OPT) || '2',
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
