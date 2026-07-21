import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001', 10),
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
};
