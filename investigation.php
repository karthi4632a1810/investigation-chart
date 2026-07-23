<?php
/**
 * Lab Result Search + Auto-Generated Investigation Chart  (v4)
 * -----------------------------------------------------------------
 * 1) Search form (RegNo, FromDate, ToDate) -> wsQueryBuilder gives the
 *    flat per-test result rows (used only to discover which Req Nos
 *    exist and which calendar date each belongs to, plus whatever
 *    patient demographic columns the feed happens to include).
 * 2) For every DISTINCT Req No found, we log in once and fetch the
 *    authoritative detail table (<table id="OrdID">) via
 *    LabResultHis.aspx - this has the real values (including text
 *    results like "Non reactive" that the flat feed reports as "--").
 * 3) Each test name is normalized and matched against a fixed
 *    template that mirrors your paper "Investigation Chart" (CBC,
 *    Blood Sugar, Renal Profile, LFT, Lipid, Urine Analysis, etc).
 *    Matched values are placed into the correct row/date column.
 * 4) Anything that doesn't match a known template row is still shown
 *    in an "Unmapped results" section so nothing gets silently lost.
 * 5) NEW: The chart is now printed under a hospital letterhead header
 *    (logo, hospital name, NABH badge, "INVESTIGATION CHART" title,
 *    and a patient info strip) that mirrors the paper form.
 * -----------------------------------------------------------------
 */

// ====== CONFIG ======
$loginUrl     = "https://emr.mapims.edu.in/BB15SE/wsLogin.asmx/chkLoginNew";
$labUrlTpl    = "https://emr.mapims.edu.in/BB15SE/Lab/LabResultHis.aspx?action=Search&Orderid=";
$queryBldrUrl = "https://emr.mapims.edu.in/BB15SE/QueryBuilder/wsQueryBuilder.asmx/Getdataset1";

$username = "Lab60464";   // UsrName
$password = "1810";       // UsrPwd
$logOpt   = "2";          // LogOpt

$cookieJar = __DIR__ . "/cookies.txt"; // session cookie storage (keep OUTSIDE webroot in production)

// ====== HOSPITAL LETTERHEAD CONFIG ======
// Point this at your logo file (place it next to this script, or give a full URL/path).
$hospitalLogoPath = "https://mh.mapims.edu.in/static/images/logo.png";
$hospitalNameEn   = "Adhiparasakthi Hospitals";
$hospitalNameTa   = "ஆதிபராசக்தி மருத்துவமனை";
$hospitalAddress  = "A clinical division of Melmaruvathur Adhiparasakthi Institute of Medical Sciences and Research<br>G.S.T. Road, Melmaruvathur - 603 319. Phone: 044-2752 8528. Toll Free: 1800 599 0999. Website: www.mapims.org";


// =========================================================
//  LOGIN
// =========================================================
function doLogin($loginUrl, $username, $password, $logOpt, $cookieJar){

    $payload = json_encode([
        "UsrName" => $username,
        "UsrPwd"  => $password,
        "LogOpt"  => $logOpt
    ]);

    $ch = curl_init($loginUrl);

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => $payload,
        CURLOPT_HTTPHEADER     => ["Content-Type: application/json; charset=UTF-8"],
        CURLOPT_COOKIEJAR      => $cookieJar,
        CURLOPT_COOKIEFILE     => $cookieJar,
        CURLOPT_FOLLOWLOCATION => true,
    ]);

    $response = curl_exec($ch);
    $err      = curl_error($ch);
    curl_close($ch);

    if($err){
        return ["ok" => false, "error" => $err];
    }

    $data = json_decode($response, true);

    if(isset($data['d']) && $data['d'] !== "" && $data['d'] !== "0" && $data['d'] !== "-1"){
        return ["ok" => true, "raw" => $data];
    }

    return ["ok" => false, "raw" => $data];
}


// =========================================================
//  FETCH FULL LAB RESULT PAGE HTML (reuses session cookie)
// =========================================================
function fetchLabResultHtml($labUrlTpl, $orderid, $cookieJar){

    $url = $labUrlTpl . urlencode($orderid);

    $ch = curl_init($url);

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_COOKIEFILE     => $cookieJar,
        CURLOPT_COOKIEJAR      => $cookieJar,
    ]);

    $html = curl_exec($ch);
    curl_close($ch);

    return $html;
}


// =========================================================
//  EXTRACT ONLY <table id="OrdID"> FROM THE FULL PAGE
// =========================================================
function extractResultTable($html){

    if(!$html) return null;

    libxml_use_internal_errors(true);

    $dom = new DOMDocument();
    $dom->loadHTML('<?xml encoding="UTF-8">' . $html, LIBXML_NOWARNING | LIBXML_NOERROR);

    libxml_clear_errors();

    $xpath = new DOMXPath($dom);
    $table = $xpath->query('//table[@id="OrdID"]')->item(0);

    if(!$table){
        return null;
    }

    return $dom->saveHTML($table);
}


// =========================================================
//  PARSE THE EXTRACTED TABLE INTO A CLEAN ARRAY
// =========================================================
function parseResultTableToArray($tableHtml){

    if(!$tableHtml) return [];

    libxml_use_internal_errors(true);
    $dom = new DOMDocument();
    $dom->loadHTML('<?xml encoding="UTF-8">' . $tableHtml, LIBXML_NOWARNING | LIBXML_NOERROR);
    libxml_clear_errors();

    $rows = $dom->getElementsByTagName('tr');
    $out  = [];

    foreach($rows as $tr){

        if(strpos($tr->getAttribute('class'), 'trtest') !== false) continue;

        $cells = $tr->getElementsByTagName('td');
        if($cells->length < 3){
            if($cells->length >= 1){
                $label = trim($cells->item(0)->textContent);
                if($label !== ''){
                    $out[] = ["section" => $label];
                }
            }
            continue;
        }

        $out[] = [
            "test"  => trim($cells->item(0)->textContent),
            "value" => trim(preg_replace('/\s+/', ' ', $cells->item(1)->textContent)),
            "range" => trim(preg_replace('/\s+/', ' ', $cells->item(2)->textContent)),
        ];
    }

    return $out;
}


// =========================================================
//  Extract Orderid + display text out of a raw "REQ NO" cell
// =========================================================
function extractOrderIdFromCell($rawValue){

    $rawValue = (string) $rawValue;

    $orderId = null;
    if(preg_match('/Orderid=(\d+)/i', $rawValue, $m)){
        $orderId = $m[1];
    }

    $display = trim(strip_tags($rawValue));
    if($display === '' && $orderId){
        $display = $orderId;
    }

    return ["orderid" => $orderId, "display" => $display];
}


// normalize a column header down to letters/digits only, lowercase
function normCol($c){
    return strtolower(preg_replace('/[^a-z0-9]/i', '', $c));
}

function parseSearchDate($raw){
    $raw = trim((string)$raw);
    if($raw === ''){
        return false;
    }

    $formats = [
        'Y-m-d\TH:i',
        'Y-m-d H:i',
        'm/d/Y H:i',
        'd-m-Y H:i',
        'm/d/Y',
        'd-m-Y',
    ];

    foreach($formats as $format){
        $dt = DateTime::createFromFormat($format, $raw);
        if($dt){
            $errors = DateTime::getLastErrors();
            if(empty($errors['warning_count']) && empty($errors['error_count'])){
                return $dt;
            }
        }
    }

    return false;
}

function normalizeSearchDate($raw){
    $dt = parseSearchDate($raw);
    if(!$dt){
        return trim((string)$raw);
    }
    return $dt->format('m/d/Y H:i');
}

function formatForDatetimeLocal($raw){
    $dt = parseSearchDate($raw);
    if(!$dt){
        return '';
    }
    return $dt->format('Y-m-d\TH:i');
}


// =========================================================
//  Normalize a test name so it can be matched against the
//  Investigation Chart template regardless of minor source
//  formatting differences (spacing, trailing "</a>", bracketed
//  panel name, trailing period, hyphen spacing, etc).
// =========================================================
function normalizeTestKey($s){
    $s = html_entity_decode((string) $s, ENT_QUOTES);
    $s = preg_replace('/<\/a>\s*$/i', '', $s);          // strip stray </a>
    $s = preg_replace('/\s*\[[^\]]*\]\s*$/', '', $s);   // strip "[PANEL NAME]"
    $s = trim($s);
    $s = rtrim($s, '. ');                                // strip trailing "."
    $s = preg_replace('/\s*-\s*/', '-', $s);            // normalize " - " -> "-"
    $s = preg_replace('/\s+/', ' ', $s);                 // collapse whitespace
    return strtoupper(trim($s));
}


// =========================================================
//  INVESTIGATION CHART TEMPLATE
//  Mirrors the paper "Investigation Chart" form layout.
//  Each field lists the normalized source test-name(s) that
//  should fill it. Add more aliases here as you discover how
//  your system names a given test.
// =========================================================
function getChartTemplate(){
    return [
        "CBC" => [
            ["id"=>"hb",       "label"=>"Hb",              "range"=>"13-17 g/dl",        "match"=>["HAEMOGLOBIN"]],
            ["id"=>"pcv",      "label"=>"PCV",             "range"=>"40-50%",            "match"=>["PACKED CELL VOLUME"]],
            ["id"=>"rbc",      "label"=>"RBC",             "range"=>"4.5-5.5 µl",        "match"=>["TOTAL RBC COUNT"]],
            ["id"=>"wbc",      "label"=>"WBC",             "range"=>"4-10 µl",           "match"=>["TOTAL WBC COUNT"]],
            ["id"=>"dcp",      "label"=>"DC - Polymorphs", "range"=>"40-80%",            "match"=>["DC-POLYMORPHS"]],
            ["id"=>"dcl",      "label"=>"DC - Lymphocytes","range"=>"20-40%",            "match"=>["DC-LYMPHOCYTES"]],
            ["id"=>"dce",      "label"=>"DC - Eosinophils","range"=>"1-6%",              "match"=>["DC-EOSINOPHILS"]],
            ["id"=>"dcm",      "label"=>"DC - Monocytes",  "range"=>"2-10%",             "match"=>["DC-MONOCYTES"]],
            ["id"=>"dcb",      "label"=>"DC - Basophils",  "range"=>"0-2%",              "match"=>["DC-BASOPHILS"]],
            ["id"=>"mcv",      "label"=>"MCV",             "range"=>"83-101 fl",         "match"=>["MCV"]],
            ["id"=>"mch",      "label"=>"MCH",             "range"=>"27-32 pg",          "match"=>["MCH"]],
            ["id"=>"mchc",     "label"=>"MCHC",            "range"=>"31.5-34.5%",        "match"=>["MCHC"]],
            ["id"=>"plt",      "label"=>"Platelets",       "range"=>"1.5-4.0 Lakhs",     "match"=>["PLATELET COUNT"]],
            ["id"=>"esr",      "label"=>"ESR 1 hrs",       "range"=>"12-35 mm",          "match"=>["ESR"]],
            ["id"=>"crp",      "label"=>"CRP",             "range"=>">6 mg/dl",          "match"=>["CRP"]],
            ["id"=>"nlr",      "label"=>"NLR",             "range"=>"1.0-3",             "match"=>["NLR"]],
        ],
        "BLOOD SUGAR" => [
            ["id"=>"rbs",  "label"=>"RBS",       "range"=>"80-140 mg/dl", "match"=>["GLUCOSE-RANDOM"]],
            ["id"=>"fbs",  "label"=>"FBS",       "range"=>"74-100 mg/dl", "match"=>["GLUCOSE-FASTING","FBS"]],
            ["id"=>"ppbs", "label"=>"PPBS",      "range"=>"90-140 mg/dl", "match"=>["GLUCOSE-PPBS","PPBS"]],
            ["id"=>"hba1c","label"=>"HbA1C",     "range"=>"5.7-6.5%",     "match"=>["HBA1C"]],
            ["id"=>"cpep", "label"=>"C-Peptide", "range"=>"",             "match"=>["C-PEPTIDE"]],
        ],
        "RENAL PROFILE" => [
            ["id"=>"urea",  "label"=>"Urea",         "range"=>"15-40 mg/dl",   "match"=>["BLOOD UREA"]],
            ["id"=>"creat", "label"=>"Creatinine",   "range"=>"0.7-1.2 mg/dl", "match"=>["SERUM CREATININE"]],
            ["id"=>"na",    "label"=>"S.Na+",        "range"=>"135-145 mmol/L","match"=>["SODIUM"]],
            ["id"=>"k",     "label"=>"S.K+",         "range"=>"3.5-5.0 mmol/L","match"=>["POTASSIUM"]],
            ["id"=>"cl",    "label"=>"S.Cl",         "range"=>"98-107 mmol/L", "match"=>["CHLORIDE"]],
            ["id"=>"hco3",  "label"=>"S.HCO3",       "range"=>"22-26 mmol/L",  "match"=>["BICARBONATE"]],
            ["id"=>"ca",    "label"=>"S.Ca2+",       "range"=>"8.6-10.3 mg/dl","match"=>["CALCIUM","SERUM CALCIUM"]],
            ["id"=>"po4",   "label"=>"S.PO4",        "range"=>"2.5-4.5 mg/dl", "match"=>["PHOSPHORUS","SERUM PHOSPHORUS"]],
            ["id"=>"uric",  "label"=>"S.Uric Acid",  "range"=>"3.5-7.2 mg/dl", "match"=>["URIC ACID","SERUM URIC ACID"]],
            ["id"=>"mg",    "label"=>"S.Mg",         "range"=>"1.7-2.4 mg/dl", "match"=>["MAGNESIUM","SERUM MAGNESIUM"]],
            ["id"=>"vitd3", "label"=>"Vit D3",       "range"=>"30-100 ng/ml",  "match"=>["VITAMIN D3","VIT D3","25-OH VITAMIN D"]],
        ],
        "CARDIAC PROFILE" => [
            ["id"=>"tropi", "label"=>"Trop I", "range"=>"2-100 ng/L", "match"=>["TROPONIN I","TROP I"]],
            ["id"=>"ckmb",  "label"=>"CKMB",   "range"=>"<5 ng/ml",   "match"=>["CK-MB","CKMB"]],
            ["id"=>"cknac", "label"=>"CKNAC",  "range"=>"46-171 U/L", "match"=>["CPK","CK-NAC","CKNAC"]],
        ],
        "PANCREAS" => [
            ["id"=>"amylase", "label"=>"S.Amylase", "range"=>"28-100 U/L", "match"=>["AMYLASE","SERUM AMYLASE"]],
            ["id"=>"lipase",  "label"=>"S.Lipase",  "range"=>"Upto 38",    "match"=>["LIPASE","SERUM LIPASE"]],
        ],
        "COAG. PROFILE" => [
            ["id"=>"pt",   "label"=>"PT",             "range"=>"11-16 seconds", "match"=>["PT","PROTHROMBIN TIME"]],
            ["id"=>"aptt", "label"=>"APTT",           "range"=>"22-36 seconds", "match"=>["APTT"]],
            ["id"=>"inr",  "label"=>"INR",            "range"=>"<1",            "match"=>["INR"]],
            ["id"=>"bt",   "label"=>"Bleeding Time",  "range"=>"2-5 Minutes",   "match"=>["BLEEDING TIME"]],
            ["id"=>"ct",   "label"=>"Clotting Time",  "range"=>"3-10 Minutes",  "match"=>["CLOTTING TIME"]],
        ],
        "THYROID" => [
            ["id"=>"ft3", "label"=>"FT3", "range"=>"2.1-4.4 pg/ml", "match"=>["FT3","FREE T3"]],
            ["id"=>"ft4", "label"=>"FT4", "range"=>"0.8-2.7 ng/dl", "match"=>["FT4","FREE T4"]],
            ["id"=>"tsh", "label"=>"TSH", "range"=>"0.4-4.5 µIU/ml","match"=>["TSH"]],
        ],
        "LIVER FUNCTION TEST" => [
            ["id"=>"tbil",  "label"=>"T.Bilirubin", "range"=>"0.1-2 mg/dl",   "match"=>["TOTAL BILIRUBIN","T.BILIRUBIN","BILIRUBIN TOTAL"]],
            ["id"=>"dbil",  "label"=>"Direct",      "range"=>"0.0-0.4 mg/dl", "match"=>["DIRECT BILIRUBIN"]],
            ["id"=>"ibil",  "label"=>"Indirect",    "range"=>"0.8-1.8 mg/dl", "match"=>["INDIRECT BILIRUBIN"]],
            ["id"=>"sgot",  "label"=>"SGOT",        "range"=>"1.0-35 U/L",    "match"=>["SGOT","AST"]],
            ["id"=>"sgpt",  "label"=>"SGPT",        "range"=>"1.0-45 U/L",    "match"=>["SGPT","ALT"]],
            ["id"=>"alp",   "label"=>"ALP",         "range"=>"53-128 U/L",    "match"=>["ALKALINE PHOSPHATASE","ALP"]],
            ["id"=>"tprot", "label"=>"T.Protein",   "range"=>"6.4-8.3 g/dl",  "match"=>["TOTAL PROTEIN"]],
            ["id"=>"alb",   "label"=>"Albumin",     "range"=>"3.5-5.2 g/dl",  "match"=>["ALBUMIN"]],
            ["id"=>"glob",  "label"=>"Globulin",    "range"=>"2.6-3.5 g/dl",  "match"=>["GLOBULIN"]],
            ["id"=>"ggt",   "label"=>"GGT",         "range"=>"1.0-55 U/L",    "match"=>["GGT"]],
        ],
        "FASTING LIPID PROFILE" => [
            ["id"=>"tchol", "label"=>"T. Cholesterol",  "range"=>"Upto 200 mg/dl", "match"=>["TOTAL CHOLESTEROL"]],
            ["id"=>"trig",  "label"=>"Triglycerides",   "range"=>"Upto 150 mg/dl", "match"=>["TRIGLYCERIDES"]],
            ["id"=>"hdl",   "label"=>"HDL Cholesterol", "range"=>"35-60 mg/dl",    "match"=>["HDL CHOLESTEROL"]],
            ["id"=>"ldl",   "label"=>"LDL Cholesterol", "range"=>"100-129 mg/dl",  "match"=>["LDL CHOLESTEROL"]],
            ["id"=>"vldl",  "label"=>"VLDL",            "range"=>"2-30 mg/dl",     "match"=>["VLDL"]],
            ["id"=>"lhr",   "label"=>"LDL/HDL Ratio",   "range"=>"3-5.1",          "match"=>["LDL/HDL RATIO"]],
        ],
        "URINE ANALYSIS" => [
            ["id"=>"ucolour", "label"=>"Colour",       "range"=>"Straw Yellow",        "match"=>["COLOUR"]],
            ["id"=>"uapp",    "label"=>"Appearance",   "range"=>"",                    "match"=>["APPEARANCE"]],
            ["id"=>"uph",     "label"=>"pH",           "range"=>"4.6-8.0",             "match"=>["PH"]],
            ["id"=>"uprot",   "label"=>"Protein",      "range"=>"Negative",            "match"=>["PROTEIN"]],
            ["id"=>"uglu",    "label"=>"Glucose",      "range"=>"Negative",            "match"=>["GLUCOSE"]],
            ["id"=>"usg",     "label"=>"Sp. Gravity",  "range"=>"1.016 to 1.025",      "match"=>["SPECIFIC GRAVITY"]],
            ["id"=>"uket",    "label"=>"Ketone",       "range"=>"Negative",            "match"=>["KETONE"]],
            ["id"=>"ubil",    "label"=>"Bilirubin",    "range"=>"Negative",            "match"=>["BILIRUBIN"]],
            ["id"=>"ublood",  "label"=>"U.Blood",      "range"=>"Negative",            "match"=>["BLOOD"]],
            ["id"=>"uleuko",  "label"=>"Leukocytes",   "range"=>"Negative",            "match"=>["LEUKOCYTES"]],
            ["id"=>"unit",    "label"=>"Nitrite",      "range"=>"",                    "match"=>["NITRITE"]],
            ["id"=>"uuro",    "label"=>"Urobilinogen", "range"=>"",                    "match"=>["UROBILINOGEN"]],
            ["id"=>"urbc",    "label"=>"RBC",          "range"=>"Up to 5 cells / HPF", "match"=>["DEP-RBC"]],
            ["id"=>"upus",    "label"=>"Pus Cells",    "range"=>"Up to 5 cells / HPF", "match"=>["DEP-PUS CELLS"]],
            ["id"=>"ucast",   "label"=>"Casts",        "range"=>"Nil",                 "match"=>["DEP-CASTS"]],
            ["id"=>"ucryst",  "label"=>"Crystals",     "range"=>"",                    "match"=>["DEP-CRYSTALS"]],
            ["id"=>"uepith",  "label"=>"Epithelial Cells","range"=>"",                 "match"=>["DEP-EPITHELIAL CELLS"]],
            ["id"=>"uother",  "label"=>"Others",       "range"=>"",                    "match"=>["DEP-OTHERS"]],
        ],
        "ANEMIA" => [
            ["id"=>"iron",   "label"=>"S.Iron",         "range"=>"70-80 mcg/dl",   "match"=>["SERUM IRON","IRON"]],
            ["id"=>"ferr",   "label"=>"S.Ferritin",     "range"=>"20-250 mcg/dl",  "match"=>["FERRITIN"]],
            ["id"=>"tibc",   "label"=>"TIBAC",          "range"=>"240-450 mcg/dl", "match"=>["TIBC","TIBAC"]],
            ["id"=>"coombs", "label"=>"Coomb's Test",   "range"=>"",               "match"=>["COOMBS TEST","COOMB'S TEST"]],
            ["id"=>"b12",    "label"=>"S.Vit B12",      "range"=>"187-883 pg/ml",  "match"=>["VITAMIN B12","VIT B12"]],
            ["id"=>"folic",  "label"=>"S.Folic Acid",   "range"=>"3.1-20.5 ng/ml", "match"=>["FOLIC ACID"]],
            ["id"=>"ldh",    "label"=>"S.LDH",          "range"=>"125-220 U/L",    "match"=>["LDH"]],
            ["id"=>"psmear", "label"=>"Peripheral Smear","range"=>"",              "match"=>["PERIPHERAL SMEAR"]],
        ],
        "SEROLOGY" => [
            ["id"=>"hiv",  "label"=>"HIV",   "range"=>"Reactive / Non reactive", "match"=>["HIV I& II (RAPID)","HIV I &II (RAPID)","HIV I & II RAPID","HIV I&II (RAPID)","HIV I& II RAPID"]],
            ["id"=>"hbsag","label"=>"HbSAg", "range"=>"Positive / Negative",     "match"=>["HBSAG RAPID","HBSAG"]],
            ["id"=>"hcv",  "label"=>"HCV",   "range"=>"Positive / Negative",     "match"=>["HCV RAPID","HCV"]],
            ["id"=>"vdrl", "label"=>"VDRL",  "range"=>"",                        "match"=>["VDRL"]],
        ],
        "BLOOD GROUP & Rh TYPE" => [
            ["id"=>"bg", "label"=>"Blood Group", "range"=>"", "match"=>["BLOOD GROUPING"]],
        ],
        "FEVER PROFILE" => [
            ["id"=>"mpmf",  "label"=>"MP/MF",         "range"=>"", "match"=>["MP/MF","MALARIA PARASITE"]],
            ["id"=>"dengue","label"=>"Dengue IgM/IgG","range"=>"", "match"=>["DENGUE IGM","DENGUE IGG","DENGUE IGM/IGG"]],
            ["id"=>"lepto", "label"=>"Lepto IgM",     "range"=>"", "match"=>["LEPTO IGM"]],
            ["id"=>"scrub", "label"=>"Scrub IgM",     "range"=>"", "match"=>["SCRUB IGM"]],
            ["id"=>"widal", "label"=>"Widal Test",    "range"=>"", "match"=>["WIDAL TEST","WIDAL"]],
        ],
    ];
}


// =========================================================
//  Build a lookup: normalizedTestKey => fieldId, plus a
//  fieldId => [section, label, range] index for rendering.
// =========================================================
function buildChartIndexes($template){
    $matchIndex = [];
    $fieldIndex = [];

    foreach($template as $section => $fields){
        foreach($fields as $field){
            $fieldIndex[$field['id']] = [
                "section" => $section,
                "label"   => $field['label'],
                "range"   => $field['range'],
            ];
            foreach($field['match'] as $alias){
                $matchIndex[$alias] = $field['id'];
            }
        }
    }

    return [$matchIndex, $fieldIndex];
}


// =========================================================
//  SEARCH: normal POST -> wsQueryBuilder
// =========================================================
function fetchSearchResults($queryBldrUrl, $regNo, $fromDate, $toDate){

    $sql = "Use KMCH_Lab EXEC LabTestResultHistoryQB
        @FromDate = '{$fromDate}',
        @ToDate = '{$toDate}',
        @RegNo = '{$regNo}',
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
        @Result = '1'";

    $payload = [
        "strQuery" => $sql,
        "strCon"   => "BB_CONSTR"
    ];

    $ch = curl_init($queryBldrUrl);

    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload),
        CURLOPT_HTTPHEADER     => ["Content-Type: application/json; charset=UTF-8"],
    ]);

    $response = curl_exec($ch);
    $err      = curl_error($ch);
    curl_close($ch);

    if($err){
        return ["ok" => false, "error" => $err];
    }

    $json = json_decode($response, true);
    $data = isset($json["d"]) ? json_decode($json["d"], true) : [];

    return ["ok" => true, "data" => $data ?: []];
}


// =========================================================
//  Detect + extract patient demographic columns (Name, Age,
//  Sex, Bed No, IP No, Ward, Unit) from the flat result feed,
//  if the feed happens to include them. Falls back to blank
//  strings so the letterhead still renders cleanly either way.
// =========================================================
function extractPatientMeta($rows, $cols){

    $colMap = [
        'name' => ['patname','patientname','name'],
        'age'  => ['age'],
        'sex'  => ['sex','gender'],
        'bed'  => ['bedno','bed'],
        'ip'   => ['ipno','ipnumber','ip'],
        'ward' => ['ward'],
        'unit' => ['unit'],
    ];

    $found = [];
    foreach($colMap as $key => $aliases){
        $found[$key] = null;
        foreach($cols as $c){
            if(in_array(normCol($c), $aliases, true)){
                $found[$key] = $c;
                break;
            }
        }
    }

    $meta = [];
    foreach($colMap as $key => $aliases){
        $meta[$key] = ($found[$key] !== null && isset($rows[0][$found[$key]]))
            ? trim((string)$rows[0][$found[$key]])
            : '';
    }

    return $meta;
}


// =========================================================
//  AJAX ENDPOINT: ?action=getdetail&orderid=261216
//  (used by the "view raw detail" popup on a Req No badge)
// =========================================================
if(isset($_GET['action']) && $_GET['action'] === 'getdetail'){

    header('Content-Type: application/json; charset=utf-8');

    $orderid = isset($_GET['orderid']) ? trim($_GET['orderid']) : '';

    if($orderid === '' || !ctype_digit($orderid)){
        echo json_encode(["ok" => false, "error" => "Missing or invalid orderid"]);
        exit;
    }

    $loginResult = doLogin($loginUrl, $username, $password, $logOpt, $cookieJar);

    if(!$loginResult['ok']){
        echo json_encode(["ok" => false, "error" => "Login failed", "detail" => $loginResult['raw'] ?? $loginResult['error']]);
        exit;
    }

    $fullHtml  = fetchLabResultHtml($labUrlTpl, $orderid, $cookieJar);
    $tableHtml = extractResultTable($fullHtml);

    if(!$tableHtml){
        echo json_encode(["ok" => false, "error" => "Result table not found (session may be invalid or Orderid has no results)"]);
        exit;
    }

    $rows = parseResultTableToArray($tableHtml);

    echo json_encode([
        "ok"      => true,
        "orderid" => $orderid,
        "rows"    => $rows
    ]);
    exit;
}


// =========================================================
//  MAIN PAGE FLOW
// =========================================================
$searchResult = null;
$regNo = $fromDate = $toDate = '';
$chartDates    = [];
$chartValues   = [];   // [fieldId][date] = value
$unmapped      = [];   // list of {test,value,range,date,orderid} not in template
$fetchErrors   = [];
$patientMeta   = ['name'=>'','age'=>'','sex'=>'','bed'=>'','ip'=>'','ward'=>'','unit'=>''];

if($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['regno'])){

    $regNo    = trim($_POST['regno']);
    $fromDate = trim($_POST['fromdate']);
    $toDate   = trim($_POST['todate']);

    $searchResult = fetchSearchResults($queryBldrUrl, $regNo, $fromDate, $toDate);

    if($searchResult['ok'] && !empty($searchResult['data'])){

        $rows = $searchResult['data'];
        $cols = array_keys($rows[0]);

        $patientMeta = extractPatientMeta($rows, $cols);

        $reqCol = $dateCol = $procCol = null;
        foreach($cols as $c){
            $n = normCol($c);
            if($reqCol === null && ($n === 'reqno' || $n === 'requestno')) $reqCol = $c;
            if($dateCol === null && $n === 'requestdate') $dateCol = $c;
            if($procCol === null && (strpos($n, 'proc') !== false || $n === 'testname' || $n === 'test' || strpos($n, 'desc') !== false)) $procCol = $c;
        }

        // discover distinct orderid -> date (date part only)
        $reqDateMap = [];
        if($reqCol){
            foreach($rows as $row){
                $parsed = extractOrderIdFromCell($row[$reqCol]);
                if(!$parsed['orderid']) continue;

                if($procCol && !empty($row[$procCol])){
                    $procName = strtoupper(trim($row[$procCol]));
                    if(
                        strpos($procName, 'PERIPHERAL SMEAR') !== false ||
                        strpos($procName, 'PERIPHERAL SMEAR STUDY') !== false ||
                        strpos($procName, 'PERIPHERAL BLOOD SMEAR') !== false ||
                        strpos($procName, 'SMEAR STUDY') !== false ||
                        strpos($procName, 'SMEAR') !== false
                    ){
                        continue; // Skip PERIPHERAL SMEAR STUDY orders
                    }
                }

                $datePart = 'Unknown';
                if($dateCol && !empty($row[$dateCol])){
                    $datePart = trim(substr(trim($row[$dateCol]), 0, 10));
                }
                $reqDateMap[$parsed['orderid']] = $datePart;
            }
        }

        if(!empty($reqDateMap)){

            $loginResult = doLogin($loginUrl, $username, $password, $logOpt, $cookieJar);

            if(!$loginResult['ok']){
                $fetchErrors[] = "Login failed while building chart: " . json_encode($loginResult['raw'] ?? $loginResult['error']);
            } else {

                [$matchIndex, $fieldIndex] = buildChartIndexes(getChartTemplate());
                $dateSet = [];

                foreach($reqDateMap as $orderid => $datePart){

                    $dateSet[$datePart] = true;

                    $fullHtml  = fetchLabResultHtml($labUrlTpl, $orderid, $cookieJar);
                    $tableHtml = extractResultTable($fullHtml);

                    if(!$tableHtml){
                        $fetchErrors[] = "Could not load detail for Req No $orderid.";
                        continue;
                    }

                    $detailRows = parseResultTableToArray($tableHtml);
                    $currentCategory = '';

                    $isIgnoredText = function($str) {
                        if (empty($str)) return false;
                        $s = strtoupper(trim($str));
                        return (
                            strpos($s, 'CLINICAL DETAILS') !== false ||
                            strpos($s, 'CRITICAL VALUE') !== false ||
                            strpos($s, 'CRITICAL VALUES') !== false ||
                            strpos($s, 'IMPRESSION') !== false ||
                            strpos($s, 'REMARK') !== false ||
                            strpos($s, 'COMMENT') !== false ||
                            strpos($s, 'SMEAR') !== false ||
                            strpos($s, 'PARASITE') !== false ||
                            strpos($s, 'NOTE') === 0
                        );
                    };

                    $isNarrativeTextValue = function($val) {
                        if (empty($val)) return false;
                        $str = trim($val);
                        if (strlen($str) > 20 && count(preg_split('/\s+/', $str)) > 3) return true;
                        $lower = strtolower($str);
                        $narrativeKeywords = [
                            'microcytic', 'hypochromic', 'normocytic', 'normochromic', 'anisopoikilocytosis',
                            'increased', 'decreased', 'reduced', 'smear', 'granulation', 'vacuolation',
                            'reactive', 'lymphocytes', 'neutrophil', 'metamyelocyte', 'predominantly',
                            'admixed', 'echinocytes', 'elliptocytes', 'target cells', 'cells/mm3',
                            'cells/cu', 'left shift', 'seen', 'adequate', 'inadequate', 'imprint', 'biopsy'
                        ];
                        foreach($narrativeKeywords as $kw){
                            if(strpos($lower, $kw) !== false) return true;
                        }
                        return false;
                    };

                    foreach($detailRows as $dr){
                        if(isset($dr['section'])) {
                            if(!$isIgnoredText($dr['section'])) {
                                $currentCategory = $dr['section'];
                            }
                            continue; // section header row, skip
                        }

                        if(
                            $isIgnoredText($dr['test']) ||
                            $isIgnoredText($currentCategory) ||
                            $isNarrativeTextValue($dr['value'] ?? '') ||
                            $isNarrativeTextValue($dr['range'] ?? '') ||
                            (!empty($dr['value']) && strlen(trim($dr['value'])) > 30) ||
                            (!empty($dr['range']) && strlen(trim($dr['range'])) > 30)
                        ) {
                            continue;
                        }

                        $key = normalizeTestKey($dr['test']);
                        if(!$key) continue;

                        if(isset($matchIndex[$key])){
                            $fieldId = $matchIndex[$key];
                            $chartValues[$fieldId][$datePart] = $dr['value'];
                        } else {
                            $unmapped[] = [
                                "test"    => $dr['test'],
                                "value"   => $dr['value'],
                                "range"   => $dr['range'],
                                "date"    => $datePart,
                                "orderid" => $orderid,
                            ];
                        }
                    }
                }

                $chartDates = array_keys($dateSet);
                // sort dates chronologically (dd-mm-yyyy)
                usort($chartDates, function($a, $b){
                    $ta = DateTime::createFromFormat('d-m-Y', $a);
                    $tb = DateTime::createFromFormat('d-m-Y', $b);
                    if(!$ta || !$tb) return strcmp($a, $b);
                    return $ta <=> $tb;
                });
            }
        }
    }
}

$chartTemplate = getChartTemplate();
?>
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Lab Result Search &amp; Investigation Chart</title>
<style>
    :root{
        --primary: #2563eb;
        --primary-dark: #1d4ed8;
        --bg: #f1f5f9;
        --card: #ffffff;
        --border: #e2e8f0;
        --text: #1e293b;
        --muted: #64748b;
        --green: #059669;
        --green-bg: #d1fae5;
        --amber: #b45309;
        --amber-bg: #fef3c7;
        --red: #dc2626;
        --red-bg: #fee2e2;
        --letter-blue: #1d4a8f;
    }
    *{ box-sizing: border-box; }
    body{
        font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
        margin: 0;
        background: var(--bg);
        color: var(--text);
    }
    .page{ max-width: 1500px; margin: 0 auto; padding: 28px 32px 60px; }

    h2{ margin: 0 0 20px; font-size: 22px; font-weight: 700; letter-spacing: -0.02em; }
    h3{ font-size: 17px; margin: 30px 0 12px; letter-spacing: -0.01em; }

    .searchbar{
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 24px;
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
        align-items: end;
        margin-bottom: 24px;
        box-shadow: 0 12px 28px rgba(15, 23, 42, .06);
    }
    .field{
        min-width: 0;
    }
    .field label{
        display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
        color: var(--muted); margin-bottom: 8px; font-weight: 700;
    }
    .field input{
        width: 100%;
        padding: 12px 14px; border: 1px solid #cbd5e1; border-radius: 12px;
        font-size: 14px; outline: none; transition: border-color .15s, box-shadow .15s;
        background: #f8fafc;
    }
    .field input:focus{ border-color: var(--primary); box-shadow: 0 0 0 4px rgba(37,99,235,.08); }
    .field.date-range input{ min-height: 44px; }
    .search-actions{
        display: flex; gap: 12px; flex-wrap: wrap; align-items: center;
    }
    .btn.secondary{
        background: #334155;
    }
    .field input:focus{ border-color: var(--primary); box-shadow: 0 0 0 3px rgba(37,99,235,.12); }

    button, .btn{
        padding: 10px 22px; border: none; border-radius: 7px; background: var(--primary);
        color: #fff; cursor: pointer; font-size: 14px; font-weight: 600; transition: background .15s;
    }
    button:hover, .btn:hover{ background: var(--primary-dark); }

    .tabs{ display:flex; gap: 6px; margin-bottom: 16px; }
    .tab-btn{
        background: #e2e8f0; color: var(--text); border:none; padding: 9px 18px;
        border-radius: 7px 7px 0 0; cursor:pointer; font-weight:600; font-size: 13px;
    }
    .tab-btn.active{ background: var(--card); color: var(--primary-dark); box-shadow: 0 -2px 0 var(--primary) inset; }
    .tab-panel{ display:none; }
    .tab-panel.active{ display:block; }

    .table-wrap{
        background: var(--card); border: 1px solid var(--border); border-radius: 10px;
        overflow: auto; max-height: 72vh; box-shadow: 0 1px 2px rgba(0,0,0,.04);
    }
    table.results{ width: 100%; border-collapse: separate; border-spacing: 0; font-size: 13px; white-space: nowrap; }
    table.results thead th{
        position: sticky; top: 0; background: #1e3a8a; color: #fff; text-align: left;
        padding: 11px 12px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em;
        font-weight: 700; z-index: 2; white-space: normal;
    }
    table.results td{ padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; white-space: normal; max-width: 260px; }
    table.results tbody tr:nth-child(even){ background: #f8fafc; }
    table.results tbody tr:hover{ background: #eff6ff; }

    .req-badge{
        display: inline-flex; align-items: center; gap: 6px; background: #dbeafe; color: var(--primary-dark);
        font-weight: 700; padding: 5px 12px; border-radius: 999px; cursor: pointer; border: 1px solid #bfdbfe;
        transition: background .15s, transform .1s; font-size: 12.5px;
    }
    .req-badge:hover{ background: #bfdbfe; }
    .req-badge:active{ transform: scale(.97); }

    .status-pill{ display: inline-block; padding: 4px 10px; border-radius: 999px; font-size: 11.5px; font-weight: 700; }
    .status-approved{ background: var(--green-bg); color: var(--green); }
    .status-pending{ background: var(--amber-bg); color: var(--amber); }
    .status-other{ background: #e2e8f0; color: var(--muted); }

    .error{ color: var(--red); background: var(--red-bg); border: 1px solid #fecaca; padding: 12px 16px; border-radius: 8px; margin-bottom: 16px; font-size: 14px; }
    .warn{ color: var(--amber); background: var(--amber-bg); border: 1px solid #fde68a; padding: 10px 14px; border-radius: 8px; margin-bottom: 14px; font-size: 13px; }
    .empty{ padding: 40px; text-align: center; color: var(--muted); background: var(--card); border: 1px solid var(--border); border-radius: 10px; }
    .result-count{ color: var(--muted); font-size: 13px; margin-bottom: 10px; }

    /* ============ LETTERHEAD HEADER ============ */
    .letterhead{
        display: flex;
        align-items: center;
        gap: 18px;
        padding: 18px 20px 14px;
        border-bottom: 3px solid var(--letter-blue);
    }
    .letterhead-logo{
        width: 64px; height: 99px; flex: 0 0 auto;
        display: flex; align-items: center; justify-content: center;
    }
    .letterhead-logo img{ max-width: 100%; max-height: 100%; object-fit: contain; }
    .letterhead-name{ flex: 1 1 auto; min-width: 220px; }
    .hosp-name-en{ font-size: 22px; font-weight: 800; color: var(--letter-blue); letter-spacing: -0.01em; }
    .hosp-name-ta{ font-size: 15px; font-weight: 700; color: var(--letter-blue); margin-top: 1px; }
    .hosp-address{ font-size: 10.5px; color: var(--muted); margin-top: 5px; line-height: 1.5; }
    .letterhead-badge{ flex: 0 0 auto; }
    .nabh-badge{
        width: 72px; height: 72px; border-radius: 50%;
        border: 3px solid var(--letter-blue); color: var(--letter-blue);
        display:flex; align-items:center; justify-content:center; text-align:center;
        font-size: 10px; font-weight: 800; line-height: 1.25; letter-spacing: .02em;
        background: #eef4ff;
    }
    .letterhead-title{ flex: 0 0 auto; text-align: right; min-width: 170px; }
    .chart-title-main{
        font-size: 18px; font-weight: 800; color: var(--letter-blue);
        background: #dbeafe; padding: 7px 14px; border-radius: 8px; letter-spacing: .02em;
        display: inline-block;
    }
    .chart-regno{ margin-top: 8px; font-size: 15px; font-weight: 700; color: var(--text); }

    .patient-strip{
        display: flex; flex-wrap: wrap; gap: 22px 30px;
        padding: 14px 20px 16px; border-bottom: 1px solid var(--border);
        background: #f8fafc;
    }
    .patient-strip .pf{ font-size: 13px; display: flex; align-items: baseline; gap: 6px; min-width: 140px; }
    .patient-strip .pf span{ color: var(--muted); font-weight: 700; text-transform: uppercase; font-size: 10.5px; letter-spacing: .03em; white-space: nowrap; }
    .patient-strip .pf b{
        font-weight: 600; color: var(--text); border-bottom: 1px dotted #94a3b8;
        padding-bottom: 1px; min-width: 60px; display: inline-block;
    }
    .patient-strip .pf b.blank{ color: #cbd5e1; }

    /* Investigation chart */
    .chart-card{
        background: var(--card); border: 1px solid var(--border); border-radius: 10px;
        box-shadow: 0 1px 2px rgba(0,0,0,.04); overflow: hidden;
    }
    .chart-card-body{ padding: 20px; overflow-x: auto; }
    .chart-header{ display:flex; justify-content: space-between; align-items:center; margin-bottom: 14px; flex-wrap: wrap; gap: 10px;}
    .chart-header .patient-meta{ font-size: 13px; color: var(--muted); }
    table.chart{ width:100%; border-collapse: collapse; font-size: 13px; min-width: 640px; }
    table.chart th, table.chart td{ border: 1px solid #cbd5e1; padding: 7px 10px; text-align: left; }
    table.chart thead th{ background: #1e3a8a; color:#fff; font-size: 12px; text-transform: uppercase; letter-spacing: .03em; white-space: nowrap; }
    tr.section-row td{ background: #dbeafe; font-weight: 800; color:#1e3a8a; text-transform: uppercase; font-size: 11.5px; letter-spacing: .04em; }
    td.field-label{ font-weight: 600; white-space: nowrap; }
    td.field-range{ color: var(--muted); font-size: 12px; white-space: nowrap; }
    td.field-value{ font-weight: 700; color: #0f172a; }
    td.field-value.filled{ background: #f0fdf4; }
    td.field-value.empty-val{ color: #cbd5e1; }

    .unmapped-box{ margin-top: 22px; }
    table.unmapped{ width:100%; border-collapse: collapse; font-size: 12.5px; }
    table.unmapped th{ background:#475569; color:#fff; padding: 8px 10px; text-align:left; font-size: 11px; text-transform: uppercase; }
    table.unmapped td{ padding: 7px 10px; border-bottom: 1px solid var(--border); }
    table.unmapped tbody tr:nth-child(even){ background:#f8fafc; }
    .hint{ color: var(--muted); font-size: 12.5px; margin-top: 6px; }

    /* Modal */
    .modal-overlay{ display:none; position:fixed; inset:0; background: rgba(15,23,42,.55); z-index: 1000; align-items: center; justify-content: center; padding: 20px; }
    .modal-overlay.show{ display:flex; }
    .modal-box{ background:#fff; width: 100%; max-width: 720px; max-height: 85vh; overflow-y: auto; border-radius: 12px; padding: 24px; position: relative; box-shadow: 0 20px 60px rgba(0,0,0,.3); }
    .modal-box h3{ margin: 0 0 4px; font-size: 18px; padding-right: 30px; }
    .modal-sub{ color: var(--muted); font-size: 13px; margin-bottom: 14px; }
    .modal-close{ position:absolute; top:16px; right:18px; cursor:pointer; font-size:22px; color: var(--muted); background:none; border:none; line-height: 1; }
    .modal-close:hover{ color: var(--text); }
    table.detail{ width:100%; border-collapse: collapse; margin-top: 6px; font-size: 13px; }
    table.detail th{ background: #1e3a8a; color:#fff; text-align:left; padding: 9px 10px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em; }
    table.detail td{ border-bottom: 1px solid var(--border); padding: 8px 10px; }
    table.detail tbody tr:nth-child(even){ background: #f8fafc; }
    tr.section-row-modal td{ background:#eef3f8 !important; font-weight:700; color:#1e3a8a; }
    .loading{ text-align:center; padding: 40px; color: var(--muted); font-size: 14px; }
    .spinner{ width: 24px; height: 24px; margin: 0 auto 10px; border: 3px solid #dbeafe; border-top-color: var(--primary); border-radius: 50%; animation: spin .8s linear infinite; }
    @keyframes spin{ to{ transform: rotate(360deg); } }

    @media print{
        .searchbar, .tabs, .modal-overlay, body *{ visibility: hidden; }
        .chart-card, .chart-card *{ visibility: visible; }
        .chart-card{ position:absolute; left:0; top:0; width:100%; border:none; box-shadow:none; }
    }
</style>
</head>
<body>
<div class="page">

<h2>Lab Result Search &amp; Investigation Chart</h2>

<form class="searchbar" method="post">
    <div class="field">
        <label>Reg No</label>
        <input type="text" name="regno" value="<?php echo htmlspecialchars($regNo); ?>" placeholder="e.g. 4975109" required>
    </div>
    <div class="field date-range">
        <label>Date of Admission</label>
        <input type="datetime-local" name="fromdate" value="<?php echo htmlspecialchars(formatForDatetimeLocal($fromDate ?: date('m/d/Y') . ' 00:00')); ?>" required>
    </div>
    <div class="field date-range">
        <label>Date of Discharge</label>
        <input type="datetime-local" name="todate" value="<?php echo htmlspecialchars(formatForDatetimeLocal($toDate ?: date('m/d/Y') . ' 23:59')); ?>" required>
    </div>
    <div class="search-actions">
        <button type="submit" class="btn">Search</button>
        <?php if($searchResult !== null && $searchResult['ok'] && !empty($searchResult['data'])): ?>
        <button type="button" class="btn secondary" onclick="window.print()">🖨️ Print Chart</button>
        <?php endif; ?>
    </div>
</form>

<?php if($searchResult !== null): ?>

    <?php if(!$searchResult['ok']): ?>
        <div class="error">Search failed: <?php echo htmlspecialchars($searchResult['error']); ?></div>

    <?php elseif(empty($searchResult['data'])): ?>
        <div class="empty">No records found for the given search.</div>

    <?php else: ?>

    <?php foreach($fetchErrors as $fe): ?>
        <div class="warn"><?php echo htmlspecialchars($fe); ?></div>
    <?php endforeach; ?>

    <div class="tabs">
        <button type="button" class="tab-btn active" onclick="showTab('chart', this)">📋 Investigation Chart</button>
        <button type="button" class="tab-btn" onclick="showTab('raw', this)">📄 Raw Results</button>
    </div>

    <!-- ============ INVESTIGATION CHART TAB ============ -->
    <div id="tab-chart" class="tab-panel active">
        <?php if(empty($chartDates)): ?>
            <div class="empty">Could not build the chart (no Req No / dates detected).</div>
        <?php else:
            // Helper to print a patient-strip field, showing a dotted blank if empty
            function pf($label, $value){
                $hasVal = trim((string)$value) !== '';
                echo '<div class="pf"><span>' . htmlspecialchars($label) . '</span>'
                   . '<b class="' . ($hasVal ? '' : 'blank') . '">'
                   . ($hasVal ? htmlspecialchars($value) : '—')
                   . '</b></div>';
            }
        ?>
        <div class="chart-card">

            <!-- Hospital letterhead -->
            <div class="letterhead">
                <div class="letterhead-logo">
                    <img src="<?php echo htmlspecialchars($hospitalLogoPath); ?>" alt="Hospital Logo"
                         onerror="this.style.display='none'">
                </div>
                <div class="letterhead-name">
                    <div class="hosp-name-en"><?php echo htmlspecialchars($hospitalNameEn); ?></div>
                    <div class="hosp-name-ta"><?php echo htmlspecialchars($hospitalNameTa); ?></div>
                    <div class="hosp-address"><?php echo $hospitalAddress; /* pre-formatted, trusted config */ ?></div>
                </div>
                <div class="letterhead-title">
                    <div class="chart-title-main">INVESTIGATION CHART</div>
                    <div class="chart-regno">Reg No: <?php echo htmlspecialchars($regNo); ?></div>
                </div>
            </div>

            <!-- Patient info strip -->
            <div class="patient-strip">
                <?php
                    pf('Patient Name', $patientMeta['name']);
                    pf('Age', $patientMeta['age']);
                    pf('Sex', $patientMeta['sex']);
                    pf('Bed No', $patientMeta['bed']);
                    pf('IP No', $patientMeta['ip']);
                    pf('Ward', $patientMeta['ward']);
                    pf('Unit', $patientMeta['unit']);
                ?>
            </div>

            <div class="chart-card-body">
            <table class="chart">
                <thead>
                <tr>
                    <th style="min-width:160px;">Parameter</th>
                    <th style="min-width:140px;">Ref. Range</th>
                    <?php foreach($chartDates as $d): ?>
                        <th><?php echo htmlspecialchars($d); ?></th>
                    <?php endforeach; ?>
                </tr>
                </thead>
                <tbody>
                <?php foreach($chartTemplate as $sectionName => $fields): ?>
                    <tr class="section-row">
                        <td colspan="<?php echo 2 + count($chartDates); ?>"><?php echo htmlspecialchars($sectionName); ?></td>
                    </tr>
                    <?php foreach($fields as $field): ?>
                        <tr>
                            <td class="field-label"><?php echo htmlspecialchars($field['label']); ?></td>
                            <td class="field-range"><?php echo htmlspecialchars($field['range']); ?></td>
                            <?php foreach($chartDates as $d):
                                $val = $chartValues[$field['id']][$d] ?? '';
                            ?>
                                <td class="field-value <?php echo $val !== '' ? 'filled' : 'empty-val'; ?>">
                                    <?php echo $val !== '' ? htmlspecialchars($val) : '—'; ?>
                                </td>
                            <?php endforeach; ?>
                        </tr>
                    <?php endforeach; ?>
                <?php endforeach; ?>
                </tbody>
            </table>

            <?php if(!empty($unmapped)): ?>
            <div class="unmapped-box">
                <h3>Unmapped results</h3>
                <div class="hint">These test results were fetched but don't match a template row yet — check the exact test name and add it as an alias in <code>getChartTemplate()</code> if it should map somewhere.</div>
                <table class="unmapped">
                    <thead><tr><th>Req No</th><th>Date</th><th>Test Name</th><th>Value</th><th>Range</th></tr></thead>
                    <tbody>
                    <?php foreach($unmapped as $u): ?>
                        <tr>
                            <td><?php echo htmlspecialchars($u['orderid']); ?></td>
                            <td><?php echo htmlspecialchars($u['date']); ?></td>
                            <td><?php echo htmlspecialchars($u['test']); ?></td>
                            <td><?php echo htmlspecialchars($u['value']); ?></td>
                            <td><?php echo htmlspecialchars($u['range']); ?></td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
            </div>
            <?php endif; ?>
            </div>
        </div>
        <?php endif; ?>
    </div>

    <!-- ============ RAW RESULTS TAB ============ -->
    <div id="tab-raw" class="tab-panel">
    <?php
        $rows = $searchResult['data'];
        $cols = array_keys($rows[0]);

        $reqCol = null; $statusCol = null;
        foreach($cols as $c){
            $n = normCol($c);
            if($reqCol === null && ($n === 'reqno' || $n === 'requestno')) $reqCol = $c;
            if($statusCol === null && $n === 'status') $statusCol = $c;
        }
    ?>
    <div class="result-count"><?php echo count($rows); ?> result row(s) found.</div>
    <div class="table-wrap">
    <table class="results">
        <thead>
        <tr>
            <?php foreach($cols as $c): ?>
                <th><?php echo htmlspecialchars($c); ?></th>
            <?php endforeach; ?>
        </tr>
        </thead>
        <tbody>
        <?php foreach($rows as $row): ?>
            <tr>
                <?php foreach($cols as $c): ?>
                    <td>
                        <?php
                        $val = $row[$c];
                        if($c === $reqCol){
                            $parsed = extractOrderIdFromCell($val);
                            if($parsed['orderid']){
                                echo '<span class="req-badge" onclick="viewDetail(\'' . htmlspecialchars($parsed['orderid'], ENT_QUOTES) . '\')">'
                                   . '<i>&#128269;</i> ' . htmlspecialchars($parsed['display'])
                                   . '</span>';
                            } else {
                                echo htmlspecialchars($parsed['display']);
                            }
                        }
                        elseif($c === $statusCol){
                            $txt = trim((string)$val);
                            $cls = 'status-other';
                            if(stripos($txt, 'approved') !== false) $cls = 'status-approved';
                            elseif(stripos($txt, 'pending') !== false) $cls = 'status-pending';
                            echo '<span class="status-pill ' . $cls . '">' . htmlspecialchars($txt) . '</span>';
                        }
                        else{
                            echo htmlspecialchars((string)$val);
                        }
                        ?>
                    </td>
                <?php endforeach; ?>
            </tr>
        <?php endforeach; ?>
        </tbody>
    </table>
    </div>
    </div>

    <?php endif; ?>

<?php endif; ?>

</div>

<!-- Detail Modal -->
<div class="modal-overlay" id="detailModal">
    <div class="modal-box">
        <button class="modal-close" onclick="closeModal()">&times;</button>
        <h3 id="detailTitle">Lab Result Detail</h3>
        <div class="modal-sub" id="detailSub"></div>
        <div id="detailBody"><div class="loading"><div class="spinner"></div>Loading...</div></div>
    </div>
</div>

<script>
function showTab(name, btn){
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.getElementById('tab-' + name).classList.add('active');
    btn.classList.add('active');
}

function viewDetail(orderid){
    const overlay = document.getElementById('detailModal');
    const title   = document.getElementById('detailTitle');
    const sub     = document.getElementById('detailSub');
    const body    = document.getElementById('detailBody');

    title.textContent = 'Lab Result Detail';
    sub.textContent = 'Request No: ' + orderid;
    body.innerHTML = '<div class="loading"><div class="spinner"></div>Loading...</div>';
    overlay.classList.add('show');

    fetch('?action=getdetail&orderid=' + encodeURIComponent(orderid))
        .then(r => r.json())
        .then(data => {
            if(!data.ok){
                body.innerHTML = '<div class="error">' + escapeHtml(data.error || 'Failed to load') + '</div>';
                return;
            }
            if(!data.rows.length){
                body.innerHTML = '<div class="empty">No test rows found for this request.</div>';
                return;
            }
            let html = '<table class="detail"><thead><tr><th>Test Name</th><th>Result Value</th><th>Biological Reference Range</th></tr></thead><tbody>';
            data.rows.forEach(row => {
                if(row.section){
                    html += '<tr class="section-row-modal"><td colspan="3">' + escapeHtml(row.section) + '</td></tr>';
                } else {
                    html += '<tr><td>' + escapeHtml(row.test) + '</td><td>' + escapeHtml(row.value) + '</td><td>' + escapeHtml(row.range) + '</td></tr>';
                }
            });
            html += '</tbody></table>';
            body.innerHTML = html;
        })
        .catch(err => {
            body.innerHTML = '<div class="error">Request failed: ' + escapeHtml(String(err)) + '</div>';
        });
}

function closeModal(){ document.getElementById('detailModal').classList.remove('show'); }

function escapeHtml(str){
    if(str === undefined || str === null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

document.getElementById('detailModal').addEventListener('click', function(e){ if(e.target === this) closeModal(); });
document.addEventListener('keydown', function(e){ if(e.key === 'Escape') closeModal(); });
</script>

</body>
</html>