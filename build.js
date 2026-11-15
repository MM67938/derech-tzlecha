// Builds public/index.html from src/app.html (the same page used inside Claude).
"use strict";
const fs = require("fs");
let app = fs.readFileSync(__dirname + "/src/app.html", "utf8");
const replace = [
  ["התכנון נעשה בעזרת Claude בחשבון שלכם. בפעם הראשונה תתבקשו לאשר.", "התכנון נעשה בעזרת בינה מלאכותית ולוקח בדרך כלל 1–3 דקות."],
  ["התכנון החכם זמין כשפותחים את הדף בתוך Claude עם חשבון מחובר.", "התכנון לא זמין כרגע. נסו שוב מאוחר יותר."],
  ["ההשוואה זמינה כשפותחים את הדף בתוך Claude עם חשבון מחובר.", "ההשוואה לא זמינה כרגע. נסו שוב מאוחר יותר."],
  ["כדי לשמור טיולים צריך לפתוח את הדף כשאתם מחוברים ל-Claude.", "שמירת טיולים לא זמינה כרגע."],
  ["ההמלצות זמינות כשפותחים את הדף מחוברים ל-Claude.", "ההמלצות לא זמינות כרגע."],
  ["לא ניתן אישור לשימוש ב-Claude בדף הזה.", "התכנון לא זמין כרגע."],
  ["לא ניתן אישור לשימוש ב-Claude.", "ההשוואה לא זמינה כרגע."],
  ["צריך להתחבר מחדש ל-Claude.", "נסו לרענן את הדף."],
  ["שמירה זמינה רק למשתמשים מחוברים.", "השמירה לא זמינה כרגע."],
  ["טיולים ששמרתם. רק אתם רואים אותם.", "טיולים ששמרתם במכשיר הזה. רק אתם רואים אותם."]
];
for (const [a, b] of replace) app = app.split(a).join(b);
const title = (app.match(/<title>([^<]*)<\/title>/) || [, "דרך צלחה"])[1];
app = app.replace(/<title>[^<]*<\/title>\s*/, "").replace(/<meta name="claude:viewport-fit-sides"[^>]*>\s*/, "");
const head = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${title}</title>
<meta name="description" content="מתכננים טיול משפחתי בארץ ובחו״ל: לינה במחיר טוב, מסלול לכל יום, אוכל כשר, בתי כנסת וזמני שבת.">
<meta name="theme-color" content="#0d7a6f">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="manifest" href="/manifest.webmanifest">
<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,-apple-system,"Segoe UI",sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>
<script src="/claude-shim.js"></script>
</head>
<body>
`;
fs.writeFileSync(__dirname + "/public/index.html", head + app + "\n</body>\n</html>\n");
console.log("built public/index.html");
