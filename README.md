# דרך צלחה – מדריך העלאה לאוויר

האתר רץ על **Cloudflare** (חינם, הרשמה עם מייל בלבד), שומר נתונים ב-**Neon** (חינם), ומתכנן טיולים עם **Claude** או **Gemini** (המפתח נשמר רק בשרת).

## מה צריך להכין (פעם אחת)

1. **חשבון GitHub** – כבר יש לך.
2. **מפתח AI** – אחד מהם או שניהם:
   - **Gemini (יש מכסה חינמית):** נכנסים ל-aistudio.google.com ← Get API key ← Create API key ← מעתיקים.
   - **Claude (בתשלום לפי שימוש):** נכנסים ל-console.anthropic.com ← Settings ← API Keys ← Create Key ← מעתיקים. צריך להטעין קרדיט בחשבון (Billing).
3. **מאגר Neon:** נכנסים ל-neon.tech ← Sign up ← Create project (אזור: Frankfurt / Europe) ← בלוח הבקרה לוחצים **Connect** ← מעתיקים את ה-Connection string (מתחיל ב-`postgresql://`).

## שלב 1 – להעלות את הקוד ל-GitHub

1. ב-github.com לוחצים **New repository**, שם: `derech-tzlecha`, Private או Public, ← Create.
2. בדף הריק לוחצים **uploading an existing file**.
3. פותחים את קובץ ה-ZIP במחשב, וגוררים **את כל מה שבתוך התיקייה** (לא את התיקייה עצמה) – כולל התיקיות `public` ו-`src`.
4. לוחצים **Commit changes**.

## שלב 2 – להקים את האתר ב-Cloudflare (בלי SMS)

1. נכנסים ל-dash.cloudflare.com ← **Sign up** עם מייל וסיסמה, ומאשרים את המייל שמגיע.
2. בתפריט: **Workers & Pages** (או Compute ← Workers) ← **Create** ← **Import a repository**.
3. מחברים את GitHub ובוחרים את `derech-tzlecha`.
4. בהגדרות:
   - **Project name:** `derech-tzlecha`
   - **Build command:** להשאיר ריק
   - **Deploy command:** `npx wrangler deploy`
5. לוחצים **Create and deploy** ומחכים שיופיע ✓.
6. נכנסים לפרויקט ← **Settings** ← **Variables and Secrets** ← **Add**, סוג **Secret**, ומוסיפים:

| שם | ערך |
|---|---|
| `GEMINI_API_KEY` | המפתח מ-Google (אם יש) |
| `ANTHROPIC_API_KEY` | המפתח מ-Anthropic (אם יש) |
| `DATABASE_URL` | ה-Connection string מ-Neon |
| `ADMIN_TOKEN` | סיסמה שתבחר |

   ובסוף לוחצים **Deploy** / **Save**.
7. הכתובת מופיעה בדף הפרויקט, למשל `https://derech-tzlecha.<השם-שלך>.workers.dev`. (בפעם הראשונה Cloudflare מבקש לבחור את `<השם-שלך>`.)

> הקבצים `server.js` ו-`store.js` משמשים להרצה על Render / Vercel / מחשב רגיל. ב-Cloudflare רץ הקובץ `worker.js`.

## בחירת מודל ה-AI

- `AI_PROVIDER=auto` – משתמש ב-Claude אם יש לו מפתח, אחרת ב-Gemini. אם אחד נופל לפני שהתחיל לענות – עובר לשני.
- `AI_PROVIDER=gemini` – קודם Gemini, ו-Claude כגיבוי.
- `AI_PROVIDER=claude` – קודם Claude, ו-Gemini כגיבוי.
- המודל עצמו נבחר אוטומטית (הכי חדש מסוג Sonnet / Flash). אפשר לקבוע ידנית עם `CLAUDE_MODEL` או `GEMINI_MODEL`.

כדי להחליף – משנים את המשתנה ב-Cloudflare ← Settings ← Variables and Secrets.

## הגנה על החשבון

כדי שאף אחד לא ינצל את המפתח שלך:
- כל מבקר יכול לתכנן עד **12 טיולים בשעה** (`PLANS_PER_HOUR`).
- כל האתר יחד – עד **400 תכנונים ביום** (`PLANS_PER_DAY_TOTAL`).
- מומלץ להגדיר גם תקרת הוצאה חודשית באתר של Anthropic / Google.

## ניהול המלצות

כדי להסיר המלצות לא ראויות: פותחים פעם אחת `https://הכתובת-שלך/?admin=הסיסמה` (מה שהגדרת ב-`ADMIN_TOKEN`). מאותו רגע, באותו דפדפן, ליד כל המלצה מופיע כפתור **הסרה**.

## טוב לדעת

- **טיולים שמורים** נשמרים לפי הדפדפן/מכשיר של המבקר (בלי הרשמה).
- **בלי `DATABASE_URL`** שמירות והמלצות לא נשמרות לאורך זמן – לכן חשוב לחבר את Neon.
- **עדכונים:** כשמשנים את האפליקציה, מחליפים את הקובץ `src/app.html` ב-GitHub. Cloudflare מעלה את הגרסה החדשה לבד (אחרי עדכון `src/app.html` מריצים `npm run build` כדי לעדכן את `public/index.html`, או מבקשים ממני קובץ מעודכן).
- **בדיקה שהאתר חי:** `https://הכתובת-שלך/healthz` מחזיר `ok`.
