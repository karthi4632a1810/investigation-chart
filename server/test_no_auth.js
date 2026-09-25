import axios from 'axios';
const url = 'https://emr.mapims.edu.in/BB15SE/Lab/LabResultHis.aspx?action=Search&Orderid=345936';

async function test() {
  try {
    const res = await axios.get(url);
    console.log(res.data.substring(0, 500));
  } catch(e) {
    console.error(e.message);
  }
}
test();
