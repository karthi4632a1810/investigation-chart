import axios from 'axios';
import { config } from 'dotenv';
config();

const loginUrl = 'https://emr.mapims.edu.in/BB15SE/wsLogin.asmx/chkLoginNew';

async function testLogin() {
  try {
    const res = await axios.post(
      loginUrl,
      { UsrName: 'your_username', UsrPwd: 'your_password', LogOpt: '2' },
      { headers: { 'Content-Type': 'application/json; charset=UTF-8' } },
    );
    console.log(res.data);
  } catch (error) {
    console.error('Error:', error.message);
  }
}
testLogin();
