import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '2000', 10),
  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017',
    dbName: process.env.MONGO_DB_NAME || 'patient_investigation',
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  emr: {
    loginUrl: process.env.EMR_LOGIN_URL,
    labUrlTemplate: process.env.EMR_LAB_URL_TEMPLATE,
    queryBuilderUrl: process.env.EMR_QUERY_BUILDER_URL,
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
