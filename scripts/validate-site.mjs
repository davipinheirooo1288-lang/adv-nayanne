import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, "public");
const assetsDir = path.join(publicDir, "assets");

const requiredFiles = [
  "public/index.html",
  "public/styles.css",
  "public/script.js",
  "vercel.json"
];

const readWebpSize = async (filePath) => {
  const buffer = await readFile(filePath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WEBP") {
    throw new Error(`${path.basename(filePath)} nao e um WebP valido`);
  }

  const chunkType = buffer.toString("ascii", 12, 16);
  if (chunkType !== "VP8X") {
    throw new Error(`${path.basename(filePath)} usa formato WebP inesperado: ${chunkType}`);
  }

  return {
    width: 1 + buffer.readUIntLE(24, 3),
    height: 1 + buffer.readUIntLE(27, 3)
  };
};

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

for (const file of requiredFiles) {
  await access(path.join(root, file));
}

const [html, css, js] = await Promise.all([
  readFile(path.join(publicDir, "index.html"), "utf8"),
  readFile(path.join(publicDir, "styles.css"), "utf8"),
  readFile(path.join(publicDir, "script.js"), "utf8")
]);

const allAssetFiles = await readdir(assetsDir);
const assetFiles = allAssetFiles.filter((file) => file.endsWith(".webp"));
assert(assetFiles.length === 12, `Esperava 12 imagens finais, encontrei ${assetFiles.length}`);
assert(!allAssetFiles.some((file) => file.endsWith(".png")), "PNG nao deve ficar dentro de public/assets");

const imageRefs = [...html.matchAll(/src="\.\/assets\/([^"]+\.webp)"/g)].map((match) => match[1]);
assert(imageRefs.length === 12, `Esperava 12 referencias de imagem no HTML, encontrei ${imageRefs.length}`);
assert(new Set(imageRefs).size === 12, "As referencias de imagem no HTML precisam ser unicas");

for (const file of imageRefs) {
  const filePath = path.join(assetsDir, file);
  await access(filePath);
  const size = await readWebpSize(filePath);
  assert(size.width >= 1400 && size.height >= 900, `${file} parece ter dimensao inesperada`);
}

const sectionCount = (html.match(/class="template-section/g) || []).length;
const hotspotCount = (html.match(/class="hotspot/g) || []).length;
assert(sectionCount === 12, `Esperava 12 secoes, encontrei ${sectionCount}`);
assert(hotspotCount >= 35, `Esperava pelo menos 35 areas clicaveis, encontrei ${hotspotCount}`);

const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
assert(jsonLdMatch, "JSON-LD ausente");
const jsonLd = JSON.parse(jsonLdMatch[1]);
assert(Array.isArray(jsonLd), "JSON-LD deve ser uma lista com LegalService e FAQPage");
assert(jsonLd.some((item) => item["@type"] === "LegalService"), "Schema LegalService ausente");
assert(jsonLd.some((item) => item["@type"] === "FAQPage"), "Schema FAQPage ausente");

assert(html.includes('<link rel="canonical" href="https://adv-nayanne.vercel.app/"'), "Canonical final ausente");
assert(html.includes('property="og:image" content="https://adv-nayanne.vercel.app/assets/'), "Meta OG image absoluta ausente");
assert(html.includes('"url": "https://adv-nayanne.vercel.app/"'), "URL do JSON-LD ausente");
assert(html.includes("nayannelisadvocacia"), "Instagram real ausente");
assert(html.includes("5577998050796") || js.includes("5577998050796"), "WhatsApp real ausente");
assert(html.includes("Google%20Maps") || html.includes("maps/search"), "Maps de busca ausente");
assert(css.includes("prefers-reduced-motion"), "CSS precisa respeitar prefers-reduced-motion");
assert(css.includes("overflow-x: clip"), "CSS precisa bloquear overflow horizontal");
assert(js.includes("IntersectionObserver"), "Animacoes de entrada via IntersectionObserver ausentes");

const totalAssetBytes = (
  await Promise.all(assetFiles.map(async (file) => (await stat(path.join(assetsDir, file))).size))
).reduce((total, size) => total + size, 0);

console.log(
  JSON.stringify(
    {
      ok: true,
      sections: sectionCount,
      hotspots: hotspotCount,
      images: assetFiles.length,
      totalAssetMb: Number((totalAssetBytes / 1024 / 1024).toFixed(2)),
      checks: [
        "arquivos essenciais",
        "12 secoes visuais",
        "assets WebP existentes",
        "links principais",
        "canonical, OG absoluto e schema SEO",
        "FAQPage schema",
        "reduced motion",
        "overflow horizontal bloqueado"
      ]
    },
    null,
    2
  )
);
