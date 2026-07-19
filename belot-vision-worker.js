/**
 * Белот AI Скенер — Cloudflare Worker
 * ------------------------------------
 * Тази функция стои между твоя статичен GitHub Pages сайт и Claude API.
 * Задачата ѝ: приема снимка от сайта, праща я на Claude с молба да разпознае
 * картите от Белот тесте, и връща резултата обратно. Ключът на Anthropic
 * никога не се вижда от браузъра — той живее само тук, като таен env secret.
 *
 * КАК ДА ГО ПУСНЕШ (накратко, пълните стъпки са в чат съобщението):
 * 1. cloudflare.com → Workers & Pages → Create → Create Worker
 * 2. Изтрий примерния код, постави целия този файл
 * 3. Settings → Variables and Secrets → Add → име: ANTHROPIC_API_KEY,
 *    стойност: твоят ключ от console.anthropic.com → Encrypt
 * 4. (по избор, но препоръчително) добави и втори secret: SHARED_SECRET
 *    с произволен низ по твой избор — same стойност после в Настройки на сайта
 * 5. Промени ALLOWED_ORIGIN по-долу на твоя истински github.io адрес
 * 6. Deploy → копирай URL-а (нещо като https://xxx.workers.dev)
 * 7. Постави го в Настройки → AI Разпознаване на сайта
 */

// Смени с истинския адрес на твоя сайт (без наклонена черта накрая), напр.:
// "https://tvoeto-ime.github.io"
// Ако искаш временно да тестваш от произволно място, остави "*", но го стесни
// после — иначе всеки, който намери линка на функцията, може да я ползва
// за сметка на твоя API баланс (ключът остава скрит, но заявките не са).
const ALLOWED_ORIGIN = "*";

// По-евтин избор: "claude-haiku-4-5-20251001" (по-бърз, малко по-нисока точност)
const MODEL = "claude-sonnet-5";

const PROMPT = `Гледаш снимка на карти от българско Белот тесте (френски тип, 32 карти:
7,8,9,10,J,Q,K,A във всяка боя — спатия, купа, каро, пика; НЯМА карти 2-6).

Разпознай всяка карта, която виждаш ясно. За всяка дай ранг и боя.
Ако не си сигурен за дадена карта (замъглена, скрита, под ъгъл) — пропусни я,
не гадай.

Отговори САМО с валиден JSON в този точен формат, без markdown, без обяснение:
{"cards":[{"rank":"K","suit":"hearts"},{"rank":"10","suit":"spades"}]}

rank е едно от: "7","8","9","10","J","Q","K","A"
suit е едно от: "spades","hearts","diamonds","clubs"
Ако не виждаш нито една карта ясно, отговори {"cards":[]}`;

export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Shared-Secret",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return json({ error: "Позволен е само POST." }, 405, corsHeaders);
    }

    // Проста защита срещу случайни/чужди заявки към твоя Worker URL.
    // Не е "сигурност на военно ниво", но спира 99% от случайното чоплене.
    if (env.SHARED_SECRET) {
      const provided = request.headers.get("X-Shared-Secret");
      if (provided !== env.SHARED_SECRET) {
        return json({ error: "Невалиден достъп." }, 401, corsHeaders);
      }
    }

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "Worker-ът няма настроен ANTHROPIC_API_KEY secret." }, 500, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Невалидно тяло на заявката." }, 400, corsHeaders);
    }

    const imageData = body.image;
    if (!imageData || typeof imageData !== "string" || !imageData.startsWith("data:image")) {
      return json({ error: "Липсва валидна снимка (data:image/...;base64,...)." }, 400, corsHeaders);
    }

    const commaIdx = imageData.indexOf(",");
    const header = imageData.slice(0, commaIdx);
    const base64Data = imageData.slice(commaIdx + 1);
    const mediaTypeMatch = header.match(/data:(image\/[a-z]+);base64/);
    const mediaType = mediaTypeMatch ? mediaTypeMatch[1] : "image/jpeg";

    // Грубо ограничение на размера (base64 е ~33% по-голям от суровите байтове) —
    // пази от неволно пращане на огромни снимки и завишени разходи.
    if (base64Data.length > 7_000_000) {
      return json({ error: "Снимката е твърде голяма." }, 413, corsHeaders);
    }

    let claudeRes;
    try {
      claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mediaType, data: base64Data } },
                { type: "text", text: PROMPT },
              ],
            },
          ],
        }),
      });
    } catch (err) {
      return json({ error: "Неуспешна връзка към Claude API.", details: String(err) }, 502, corsHeaders);
    }

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      return json({ error: "Claude API върна грешка.", status: claudeRes.status, details: errText }, 502, corsHeaders);
    }

    const claudeData = await claudeRes.json();
    const textBlock = (claudeData.content || []).find((b) => b.type === "text");
    const rawText = textBlock ? textBlock.text : "{}";

    // Claude понякога опакова JSON-а в ```json ... ``` въпреки инструкцията — чистим.
    const cleaned = rawText.replace(/```json/gi, "").replace(/```/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      return json({ error: "Неразбираем отговор от AI.", raw: rawText }, 502, corsHeaders);
    }

    const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
    return json({ cards }, 200, corsHeaders);
  },
};

function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}
