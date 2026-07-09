export function getChartTemplate() {
  return {
    CBC: [
      { id: 'hb', label: 'Hb', range: '13-17 g/dl', match: ['HAEMOGLOBIN'] },
      { id: 'pcv', label: 'PCV', range: '40-50%', match: ['PACKED CELL VOLUME'] },
      { id: 'rbc', label: 'RBC', range: '4.5-5.5 µl', match: ['TOTAL RBC COUNT'] },
      { id: 'wbc', label: 'WBC', range: '4-10 µl', match: ['TOTAL WBC COUNT'] },
      { id: 'dcp', label: 'DC - Polymorphs', range: '40-80%', match: ['DC-POLYMORPHS'] },
      { id: 'dcl', label: 'DC - Lymphocytes', range: '20-40%', match: ['DC-LYMPHOCYTES'] },
      { id: 'dce', label: 'DC - Eosinophils', range: '1-6%', match: ['DC-EOSINOPHILS'] },
      { id: 'dcm', label: 'DC - Monocytes', range: '2-10%', match: ['DC-MONOCYTES'] },
      { id: 'dcb', label: 'DC - Basophils', range: '0-2%', match: ['DC-BASOPHILS'] },
      { id: 'mcv', label: 'MCV', range: '83-101 fl', match: ['MCV'] },
      { id: 'mch', label: 'MCH', range: '27-32 pg', match: ['MCH'] },
      { id: 'mchc', label: 'MCHC', range: '31.5-34.5%', match: ['MCHC'] },
      { id: 'plt', label: 'Platelets', range: '1.5-4.0 Lakhs', match: ['PLATELET COUNT'] },
      { id: 'esr', label: 'ESR 1 hrs', range: '12-35 mm', match: ['ESR'] },
      { id: 'crp', label: 'CRP', range: '>6 mg/dl', match: ['CRP'] },
      { id: 'nlr', label: 'NLR', range: '1.0-3', match: ['NLR'] },
    ],
    'BLOOD SUGAR': [
      { id: 'rbs', label: 'RBS', range: '80-140 mg/dl', match: ['GLUCOSE-RANDOM'] },
      { id: 'fbs', label: 'FBS', range: '74-100 mg/dl', match: ['GLUCOSE-FASTING', 'FBS'] },
      { id: 'ppbs', label: 'PPBS', range: '90-140 mg/dl', match: ['GLUCOSE-PPBS', 'PPBS'] },
      { id: 'hba1c', label: 'HbA1C', range: '5.7-6.5%', match: ['HBA1C'] },
      { id: 'cpep', label: 'C-Peptide', range: '', match: ['C-PEPTIDE'] },
    ],
    'RENAL PROFILE': [
      { id: 'urea', label: 'Urea', range: '15-40 mg/dl', match: ['BLOOD UREA'] },
      { id: 'creat', label: 'Creatinine', range: '0.7-1.2 mg/dl', match: ['SERUM CREATININE'] },
      { id: 'na', label: 'S.Na+', range: '135-145 mmol/L', match: ['SODIUM'] },
      { id: 'k', label: 'S.K+', range: '3.5-5.0 mmol/L', match: ['POTASSIUM'] },
      { id: 'cl', label: 'S.Cl', range: '98-107 mmol/L', match: ['CHLORIDE'] },
      { id: 'hco3', label: 'S.HCO3', range: '22-26 mmol/L', match: ['BICARBONATE'] },
      { id: 'ca', label: 'S.Ca2+', range: '8.6-10.3 mg/dl', match: ['CALCIUM', 'SERUM CALCIUM'] },
      { id: 'po4', label: 'S.PO4', range: '2.5-4.5 mg/dl', match: ['PHOSPHORUS', 'SERUM PHOSPHORUS'] },
      { id: 'uric', label: 'S.Uric Acid', range: '3.5-7.2 mg/dl', match: ['URIC ACID', 'SERUM URIC ACID'] },
      { id: 'mg', label: 'S.Mg', range: '1.7-2.4 mg/dl', match: ['MAGNESIUM', 'SERUM MAGNESIUM'] },
      { id: 'vitd3', label: 'Vit D3', range: '30-100 ng/ml', match: ['VITAMIN D3', 'VIT D3', '25-OH VITAMIN D'] },
    ],
    'CARDIAC PROFILE': [
      { id: 'tropi', label: 'Trop I', range: '2-100 ng/L', match: ['TROPONIN I', 'TROP I'] },
      { id: 'ckmb', label: 'CKMB', range: '<5 ng/ml', match: ['CK-MB', 'CKMB'] },
      { id: 'cknac', label: 'CKNAC', range: '46-171 U/L', match: ['CPK', 'CK-NAC', 'CKNAC'] },
    ],
    PANCREAS: [
      { id: 'amylase', label: 'S.Amylase', range: '28-100 U/L', match: ['AMYLASE', 'SERUM AMYLASE'] },
      { id: 'lipase', label: 'S.Lipase', range: 'Upto 38', match: ['LIPASE', 'SERUM LIPASE'] },
    ],
    'COAG. PROFILE': [
      { id: 'pt', label: 'PT', range: '11-16 seconds', match: ['PT', 'PROTHROMBIN TIME'] },
      { id: 'aptt', label: 'APTT', range: '22-36 seconds', match: ['APTT'] },
      { id: 'inr', label: 'INR', range: '<1', match: ['INR'] },
      { id: 'bt', label: 'Bleeding Time', range: '2-5 Minutes', match: ['BLEEDING TIME'] },
      { id: 'ct', label: 'Clotting Time', range: '3-10 Minutes', match: ['CLOTTING TIME'] },
    ],
    THYROID: [
      { id: 'ft3', label: 'FT3', range: '2.1-4.4 pg/ml', match: ['FT3', 'FREE T3'] },
      { id: 'ft4', label: 'FT4', range: '0.8-2.7 ng/dl', match: ['FT4', 'FREE T4'] },
      { id: 'tsh', label: 'TSH', range: '0.4-4.5 µIU/ml', match: ['TSH'] },
    ],
    'LIVER FUNCTION TEST': [
      { id: 'tbil', label: 'T.Bilirubin', range: '0.1-2 mg/dl', match: ['TOTAL BILIRUBIN', 'T.BILIRUBIN', 'BILIRUBIN TOTAL'] },
      { id: 'dbil', label: 'Direct', range: '0.0-0.4 mg/dl', match: ['DIRECT BILIRUBIN'] },
      { id: 'ibil', label: 'Indirect', range: '0.8-1.8 mg/dl', match: ['INDIRECT BILIRUBIN'] },
      { id: 'sgot', label: 'SGOT', range: '1.0-35 U/L', match: ['SGOT', 'AST'] },
      { id: 'sgpt', label: 'SGPT', range: '1.0-45 U/L', match: ['SGPT', 'ALT'] },
      { id: 'alp', label: 'ALP', range: '53-128 U/L', match: ['ALKALINE PHOSPHATASE', 'ALP'] },
      { id: 'tprot', label: 'T.Protein', range: '6.4-8.3 g/dl', match: ['TOTAL PROTEIN'] },
      { id: 'alb', label: 'Albumin', range: '3.5-5.2 g/dl', match: ['ALBUMIN'] },
      { id: 'glob', label: 'Globulin', range: '2.6-3.5 g/dl', match: ['GLOBULIN'] },
      { id: 'ggt', label: 'GGT', range: '1.0-55 U/L', match: ['GGT'] },
    ],
    'FASTING LIPID PROFILE': [
      { id: 'tchol', label: 'T. Cholesterol', range: 'Upto 200 mg/dl', match: ['TOTAL CHOLESTEROL'] },
      { id: 'trig', label: 'Triglycerides', range: 'Upto 150 mg/dl', match: ['TRIGLYCERIDES'] },
      { id: 'hdl', label: 'HDL Cholesterol', range: '35-60 mg/dl', match: ['HDL CHOLESTEROL'] },
      { id: 'ldl', label: 'LDL Cholesterol', range: '100-129 mg/dl', match: ['LDL CHOLESTEROL'] },
      { id: 'vldl', label: 'VLDL', range: '2-30 mg/dl', match: ['VLDL'] },
      { id: 'lhr', label: 'LDL/HDL Ratio', range: '3-5.1', match: ['LDL/HDL RATIO'] },
    ],
    'URINE ANALYSIS': [
      { id: 'ucolour', label: 'Colour', range: 'Straw Yellow', match: ['COLOUR'] },
      { id: 'uapp', label: 'Appearance', range: '', match: ['APPEARANCE'] },
      { id: 'uph', label: 'pH', range: '4.6-8.0', match: ['PH'] },
      { id: 'uprot', label: 'Protein', range: 'Negative', match: ['PROTEIN'] },
      { id: 'uglu', label: 'Glucose', range: 'Negative', match: ['GLUCOSE'] },
      { id: 'usg', label: 'Sp. Gravity', range: '1.016 to 1.025', match: ['SPECIFIC GRAVITY'] },
      { id: 'uket', label: 'Ketone', range: 'Negative', match: ['KETONE'] },
      { id: 'ubil', label: 'Bilirubin', range: 'Negative', match: ['BILIRUBIN'] },
      { id: 'ublood', label: 'U.Blood', range: 'Negative', match: ['BLOOD'] },
      { id: 'uleuko', label: 'Leukocytes', range: 'Negative', match: ['LEUKOCYTES'] },
      { id: 'unit', label: 'Nitrite', range: '', match: ['NITRITE'] },
      { id: 'uuro', label: 'Urobilinogen', range: '', match: ['UROBILINOGEN'] },
      { id: 'urbc', label: 'RBC', range: 'Up to 5 cells / HPF', match: ['DEP-RBC'] },
      { id: 'upus', label: 'Pus Cells', range: 'Up to 5 cells / HPF', match: ['DEP-PUS CELLS'] },
      { id: 'ucast', label: 'Casts', range: 'Nil', match: ['DEP-CASTS'] },
      { id: 'ucryst', label: 'Crystals', range: '', match: ['DEP-CRYSTALS'] },
      { id: 'uepith', label: 'Epithelial Cells', range: '', match: ['DEP-EPITHELIAL CELLS'] },
      { id: 'uother', label: 'Others', range: '', match: ['DEP-OTHERS'] },
    ],
    ANEMIA: [
      { id: 'iron', label: 'S.Iron', range: '70-80 mcg/dl', match: ['SERUM IRON', 'IRON'] },
      { id: 'ferr', label: 'S.Ferritin', range: '20-250 mcg/dl', match: ['FERRITIN'] },
      { id: 'tibc', label: 'TIBAC', range: '240-450 mcg/dl', match: ['TIBC', 'TIBAC'] },
      { id: 'coombs', label: "Coomb's Test", range: '', match: ["COOMBS TEST", "COOMB'S TEST"] },
      { id: 'b12', label: 'S.Vit B12', range: '187-883 pg/ml', match: ['VITAMIN B12', 'VIT B12'] },
      { id: 'folic', label: 'S.Folic Acid', range: '3.1-20.5 ng/ml', match: ['FOLIC ACID'] },
      { id: 'ldh', label: 'S.LDH', range: '125-220 U/L', match: ['LDH'] },
      { id: 'psmear', label: 'Peripheral Smear', range: '', match: ['PERIPHERAL SMEAR'] },
    ],
    SEROLOGY: [
      { id: 'hiv', label: 'HIV', range: 'Reactive / Non reactive', match: ['HIV I& II (RAPID)', 'HIV I &II (RAPID)', 'HIV I & II RAPID', 'HIV I&II (RAPID)', 'HIV I& II RAPID'] },
      { id: 'hbsag', label: 'HbSAg', range: 'Positive / Negative', match: ['HBSAG RAPID', 'HBSAG'] },
      { id: 'hcv', label: 'HCV', range: 'Positive / Negative', match: ['HCV RAPID', 'HCV'] },
      { id: 'vdrl', label: 'VDRL', range: '', match: ['VDRL'] },
    ],
    'BLOOD GROUP & Rh TYPE': [
      { id: 'bg', label: 'Blood Group', range: '', match: ['BLOOD GROUPING'] },
    ],
    'FEVER PROFILE': [
      { id: 'mpmf', label: 'MP/MF', range: '', match: ['MP/MF', 'MALARIA PARASITE'] },
      { id: 'dengue', label: 'Dengue IgM/IgG', range: '', match: ['DENGUE IGM', 'DENGUE IGG', 'DENGUE IGM/IGG'] },
      { id: 'lepto', label: 'Lepto IgM', range: '', match: ['LEPTO IGM'] },
      { id: 'scrub', label: 'Scrub IgM', range: '', match: ['SCRUB IGM'] },
      { id: 'widal', label: 'Widal Test', range: '', match: ['WIDAL TEST', 'WIDAL'] },
    ],
  };
}

export function buildChartIndexes(template) {
  const matchIndex = {};
  const fieldIndex = {};

  for (const [section, fields] of Object.entries(template)) {
    for (const field of fields) {
      fieldIndex[field.id] = {
        section,
        label: field.label,
        range: field.range,
      };
      for (const alias of field.match) {
        matchIndex[alias] = field.id;
      }
    }
  }

  return [matchIndex, fieldIndex];
}

export function normalizeTestKey(s) {
  let text = String(s);
  text = text.replace(/<\/a>\s*$/i, '');
  text = text.replace(/\s*\[[^\]]*\]\s*$/, '');
  text = text.trim().replace(/[.\s]+$/, '');
  text = text.replace(/\s*-\s*/g, '-');
  text = text.replace(/\s+/g, ' ');
  return text.trim().toUpperCase();
}
