import { config } from './src/config.js';
import axios from 'axios';
import { normalizeTestKey } from './src/templates/chartTemplate.js';

async function run() {
  const payload = {
      strQuery: "Use KMCH_Lab; SELECT p.cProc_Name, g.cGroup_Name FROM Mast_Proc p JOIN Proc_Group g ON p.iProc_Group_id = g.iProc_Group_id",
      strCon: "BB_CONSTR"
  };
  const response = await axios.post(config.emr.retDatatableUrl, payload, {
      headers: { 'Content-Type': 'application/json' }
  });
  const records = JSON.parse(response.data.d);
  const dynGroups = {};
  for (const rec of records) {
      if (rec.cProc_Name && rec.cGroup_Name) {
        dynGroups[normalizeTestKey(rec.cProc_Name)] = rec.cGroup_Name.trim().toUpperCase();
      }
  }
  console.log("COLOUR:", dynGroups['COLOUR']);
  console.log("A/G RATIO:", dynGroups['A/G RATIO']);
  console.log("HIV I & II RAPID:", dynGroups['HIV I & II RAPID']);
}
run();
