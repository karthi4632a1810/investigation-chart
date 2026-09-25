import axios from 'axios';
import { config } from 'dotenv';
config();

const queryBuilderUrl = 'https://emr.mapims.edu.in/BB15SE/QueryBuilder/wsQueryBuilder.asmx/Getdataset1';
const fromDate = '07/20/2026 00:00';
const toDate = '07/21/2026 23:59';
const regNo = '4625656';

const sql = `Use KMCH_Lab EXEC LabTestResultHistoryQB
      @FromDate = '${fromDate}',
      @ToDate = '${toDate}',
      @RegNo = '${regNo}',
      @RequestNo = '',
      @IPNO = '',
      @BillNo = '',
      @PatName = '',
      @BedNo = '',
      @Dept = '',
      @Doc = '0',
      @Proc = '0',
      @PatCategory = '1,2,3',
      @Status = '0',
      @bDiscaintimation = '1',
      @PatType = '0',
      @Result = '1'`;

async function test() {
  try {
    const res = await axios.post(
      queryBuilderUrl,
      { strQuery: sql, strCon: 'BB_CONSTR' },
      { headers: { 'Content-Type': 'application/json; charset=UTF-8' } },
    );
    console.log(res.data);
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}
test();
