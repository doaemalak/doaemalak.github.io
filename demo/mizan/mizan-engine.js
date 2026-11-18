// Moteur de recherche de la démo Mizan — portage JavaScript du canal lexical
// du projet (src/retrieval/normalisation.py, synonymes.py, bm25_search.py et
// des mots-clés juridiques de src/graph/legal_rag_graph.py).
//
// Ce qui tourne ici, dans le navigateur, sur le vrai corpus :
//   1. normalisation bilingue (diacritiques, alif, ta marbuta, accents) ;
//   2. pont français → arabe (termes du législateur, vérifiés dans le corpus) ;
//   3. BM25 Okapi sur DEUX formulations, fusionnées par rang réciproque (RRF) ;
//   4. porte de confiance : sous le seuil, pas de réponse, une orientation.
// Ce qui ne tourne qu'en local (Ollama, Qdrant) : vecteurs BGE-M3, reranker
// BGE-v2-m3, génération Qwen 2.5 et vérification des citations.

(function (racine) {
  "use strict";

  // ---------- Normalisation (identique des deux côtés : corpus et question) ----------
  const DIACRITIQUES = /[ؐ-ًؚ-ٰٟۖ-ۭ]/g;
  const EQUIV = {
    "أ": "ا", "إ": "ا", "آ": "ا", "ٱ": "ا", "ى": "ي", "ئ": "ي", "ة": "ه", "ؤ": "و",
    "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  };
  const RE_EQUIV = new RegExp("[" + Object.keys(EQUIV).join("") + "]", "g");
  const RE_JETON = /[\p{L}\p{N}_]+/gu;
  const ARABE = /[؀-ۿ]/;

  function normaliserLatin(t) {
    // minuscules et sans accents, sans toucher aux signes arabes
    return t.toLowerCase().normalize("NFD")
      .replace(/\p{Mn}/gu, (c) => (c >= "؀" && c <= "ۿ" ? c : ""))
      .normalize("NFC");
  }
  function normaliserArabe(t) {
    return t.replace(DIACRITIQUES, "").replace(/ـ/g, "").replace(RE_EQUIV, (c) => EQUIV[c]);
  }
  const normaliser = (t) => normaliserArabe(normaliserLatin(t));
  const jetons = (t) => normaliser(t).match(RE_JETON) || [];

  // ---------- Synonymes juridiques (appliqués à la question seulement) ----------
  const SYN_BRUT = {
    qualifie: ["arme", "nuit", "effraction", "escalade", "fausses", "cles", "reunion"],
    "الموصوفه": ["سلاح", "ليل", "كسر", "تسلق", "مفاتيح", "مزوره", "تعدد"],
    vol: ["سرقه", "اختلاس", "soustraction"],
    "سرقه": ["vol", "اختلاس"],
    homicide: ["قتل", "meurtre", "mort", "involontaire"],
    involontaire: ["اهمال", "عدم", "احتياط", "negligence", "غير", "عمدي"],
    meurtre: ["قتل", "عمدا", "homicide"],
    legitime: ["defense", "الدفاع", "الشرعي"],
    defense: ["legitime", "الدفاع", "الشرعي"],
    garde: ["vue", "الحراسه", "النظريه", "مده", "ساعه", "تمديد"],
    vue: ["garde", "الحراسه", "النظريه"],
    "حراسه": ["نظريه", "تمديد", "مده", "ساعه", "garde"],
    detention: ["preventive", "الاعتقال", "الاحتياطي", "حبس"],
    appel: ["استيناف", "محكمه", "طعن"],
    perquisition: ["تفتيش", "منزل", "المنزل"],
    // « ليال » : forme abîmée de « ليلا » par l'extraction PDF (ligature lam-alef)
    nuit: ["ليلا", "ليال", "ليلي", "الليل"],
    flagrant: ["delit", "تلبس", "التلبس"],
    vitesse: ["السرعه", "km", "depassement", "تجاوز"],
    "السرعه": ["vitesse", "تجاوز", "km"],
    feu: ["rouge", "الضوء", "الاحمر", "اشاره"],
    rouge: ["feu", "الضوء", "الاحمر", "اشاره"],
    fuite: ["delit", "فرار", "الفرار", "هرب", "حادثه", "accident"],
    delit: ["fuite", "جنحه", "فرار", "الفرار"],
    permis: ["conduire", "رخصه", "السياقه", "points", "النقط"],
    points: ["النقط", "رخصه", "خصم"],
    alcool: ["كحول", "سكر", "ivresse", "etat"],
    ivresse: ["alcool", "سكر", "كحول"],
    accident: ["حادثه", "حادث", "سير", "collision"],
    "حادثه": ["accident", "سير", "حادث"],
    ceinture: ["حزام", "السلامه", "securite"],
    casque: ["خوذه", "الخوذه"],
    assurance: ["تامين", "التامين"],
    stationnement: ["وقوف", "التوقف"],
    priorite: ["اسبقيه", "الاولويه"],
  };
  const SYNONYMES = {};
  for (const [k, v] of Object.entries(SYN_BRUT)) SYNONYMES[normaliser(k)] = v.map(normaliser);

  function jetonsQuestion(t) {
    const base = jetons(t);
    const out = base.slice();
    for (const j of base) if (SYNONYMES[j]) out.push(...SYNONYMES[j]);
    return out;
  }

  // ---------- Pont français → arabe : termes EMPLOYÉS PAR LE CORPUS ----------
  // [motif sur la question repliée, libellé français, terme arabe, code]
  const MOTS_CLES = [
    [/\blignes? (continue|blanche)/, "ligne continue", "خط متصل", "CR"],
    [/\btracteur/, "tracteur", "جرار", "CR"],
    [/\bdepass/, "dépassement", "التجاوز", "CR"],
    [/\bvitesse\b/, "vitesse", "السرعة", "CR"],
    [/\bstationn/, "stationnement", "الوقوف", "CR"],
    [/\b(ivresse|alcool|ebriete)/, "état d'ivresse", "حالة سكر", "CR"],
    [/(?<!permis de )\bcondui/, "conduite d'un véhicule", "يسوق مركبة", "CR"],
    [/\bpermis\b/, "permis de conduire", "رخصة السياقة", "CR"],
    [/\bfeu rouge/, "feu rouge", "إشارة الضوء الأحمر", "CR"],
    [/\bdelit de fuite/, "délit de fuite", "الفرار بعد ارتكاب حادثة", "CR"],
    [/\bassurance/, "assurance", "التأمين", "CR"],
    [/\bviolation de domicile/, "violation de domicile", "حرمة المسكن", "CP"],
    [/\b(domicile|maison|logement)/, "domicile", "المسكن", "CP"],
    [/\beffraction/, "effraction", "الكسر", "CP"],
    [/\bescalade/, "escalade", "التسلق", "CP"],
    [/\bvol simple/, "vol simple", "اختلس عمدا مالا مملوكا للغير", "CP"],
    [/\bvol(s|er|e|ee|eur|euse)?\b/, "vol", "السرقة", "CP"],
    [/\b(bruit|tapage)/, "tapage", "الضجيج", "CP"],
    [/\b(coups?|blessures?)\b/, "coups et blessures", "الضرب والجرح", "CP"],
    [/\bescroquerie/, "escroquerie", "النصب", "CP"],
    [/\babus de confiance/, "abus de confiance", "خيانة الأمانة", "CP"],
    [/\blegitime defense/, "légitime défense", "الدفاع الشرعي", "CP"],
    [/\bhomicide involontaire/, "homicide involontaire", "القتل غير العمدي", "CP"],
    [/\bperquisition/, "perquisition", "تفتيش المنازل", "CPP"],
    [/\bgarde a vue/, "garde à vue", "الحراسة النظرية", "CPP"],
    [/\bflagran/, "flagrant délit", "التلبس", "CPP"],
    [/\bdetention preventive/, "détention préventive", "الاعتقال الاحتياطي", "CPP"],
    [/\b(cour d'?)?appel\b/, "appel", "استئناف", "CPP"],
  ];
  const replier = (t) => t.toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "");

  function pontBilingue(question) {
    const q = replier(question);
    const vus = new Set();
    const out = [];
    for (const [motif, libelle, terme, code] of MOTS_CLES) {
      if (motif.test(q) && !vus.has(terme)) { vus.add(terme); out.push({ libelle, terme, code }); }
    }
    return out;
  }

  // ---------- BM25 Okapi (mêmes paramètres que rank_bm25 : k1 = 1,5 ; b = 0,75) ----------
  const K1 = 1.5, B = 0.75, EPSILON = 0.25, RRF_K = 60;

  function construireIndex(corpus) {
    const docs = corpus.map((a) => {
      const tf = new Map();
      const js = jetons(a[3]);
      for (const j of js) tf.set(j, (tf.get(j) || 0) + 1);
      return { tf, len: js.length };
    });
    const df = new Map();
    for (const d of docs) for (const j of d.tf.keys()) df.set(j, (df.get(j) || 0) + 1);
    const N = docs.length;
    const avgdl = docs.reduce((s, d) => s + d.len, 0) / N;
    // idf de rank_bm25 : les termes trop fréquents reçoivent epsilon × idf moyen
    const idf = new Map();
    let somme = 0;
    const negatifs = [];
    for (const [j, n] of df) {
      const v = Math.log(N - n + 0.5) - Math.log(n + 0.5);
      idf.set(j, v); somme += v;
      if (v < 0) negatifs.push(j);
    }
    const plancher = EPSILON * (somme / idf.size);
    for (const j of negatifs) idf.set(j, plancher);
    const idfMax = Math.log(N + 0.5) - Math.log(0.5);
    return { corpus, docs, idf, avgdl, idfMax };
  }

  function scores(index, termes) {
    const { docs, idf, avgdl } = index;
    const s = new Float64Array(docs.length);
    for (const q of termes) {
      const w = idf.get(q);
      if (!w) continue;
      for (let i = 0; i < docs.length; i++) {
        const f = docs[i].tf.get(q);
        if (!f) continue;
        s[i] += w * (f * (K1 + 1)) / (f + K1 * (1 - B + B * docs[i].len / avgdl));
      }
    }
    return s;
  }

  // ---------- Confiance : part des CONCEPTS de la question présents dans l'article ----------
  // Remplace ici le score du reranker (non exécutable dans un navigateur).
  // Chaque mot porteur de sens pèse son idf ; un mot absent du corpus pèse
  // l'idf maximal : une question sur une « SARL » ne peut donc pas être
  // couverte par le Code Pénal, même si ses autres mots y figurent.
  const MOTS_VIDES = new Set(normaliser(
    "a au aux avec ce ces cet cette comment dans de des du elle elles en est et etre il ils je la le les leur lui " +
    "ma mais me mes moi mon ne ni nos notre nous on ou par pas pour peut peuvent puis quand que quel quelle quelles " +
    "quels qui quoi sa sans se ses si son sont sur ta te tes toi ton tu un une vos votre vous y avoir faire fait " +
    "risque risquer risquent risquons sanction sanctions peine peines puni punie quoi combien quelle duree maximale " +
    "maximum minimum est-ce qu ce c d l s t n m j apres avant lors cas loi droit droits maroc marocain marocaine lieu entre " +
    "ما ماذا هل كيف متى من في على عن الى او ثم هي هو التي الذي عقوبه عقوبات مده المغرب القانون"
  ).split(/\s+/));

  function concepts(question, pont, idxIdf, idfMax) {
    const pontJetons = pont.map((p) => ({ libelle: jetons(p.libelle), terme: jetons(p.terme) }));
    const vus = new Set();
    const out = [];
    for (const t of jetons(question)) {
      if (MOTS_VIDES.has(t) || t.length < 2 || /^\d+$/.test(t) || vus.has(t)) continue;
      vus.add(t);
      const variantes = [[t], ...(SYNONYMES[t] || []).map((s) => [s])];
      for (const p of pontJetons) if (p.libelle.some((l) => l.slice(0, 5) === t.slice(0, 5))) variantes.push(p.terme);
      out.push({ mot: t, poids: idxIdf.get(t) || idfMax, variantes });
    }
    return out;
  }

  // Un mot est présent s'il figure tel quel, ou par son radical (« divorcer » / « divorce »).
  function present(doc, j) {
    if (doc.tf.has(j)) return true;
    if (j.length < 6 || ARABE.test(j)) return false;
    const radical = j.slice(0, 6);
    for (const k of doc.tf.keys()) if (k.startsWith(radical)) return true;
    return false;
  }

  function couverture(doc, cs) {
    let total = 0, couvert = 0;
    for (const c of cs) {
      total += c.poids;
      if (c.variantes.some((v) => v.every((j) => present(doc, j)))) couvert += c.poids;
    }
    return total ? couvert / total : 0;
  }

  function classer(s, n) {
    return Array.from(s.keys()).filter((i) => s[i] > 0)
      .sort((a, b) => s[b] - s[a]).slice(0, n);
  }

  const SEUIL_CONFIANCE = 0.65;     // sous ce seuil : orientation, pas de réponse
  const SEUIL_ELEVEE = 0.9;

  function rechercher(index, question, topK = 5) {
    const t0 = performance.now();
    const langue = ARABE.test(question) ? "ar" : "fr";
    const pont = pontBilingue(question);

    // Deux formulations, comme dans le projet : la question d'origine,
    // et sa formulation arabe (ici, les termes du législateur repérés).
    const f1 = jetonsQuestion(question);
    const formulationArabe = pont.map((p) => p.terme).join(" ");
    const f2 = formulationArabe ? jetonsQuestion(formulationArabe) : [];

    const s1 = scores(index, f1), s2 = f2.length ? scores(index, f2) : null;
    const l1 = classer(s1, 30), l2 = s2 ? classer(s2, 30) : [];

    // Fusion par rang réciproque
    const rrf = new Map();
    [l1, l2].forEach((liste) => liste.forEach((i, r) => rrf.set(i, (rrf.get(i) || 0) + 1 / (RRF_K + r + 1))));
    const candidats = Array.from(rrf.keys()).sort((a, b) => rrf.get(b) - rrf.get(a)).slice(0, 30);

    // Reclassement des 30 candidats fusionnés par couverture des concepts
    const cs = concepts(question, pont, index.idf, index.idfMax);
    const resultats = candidats.map((i, rang) => {
      const a = index.corpus[i];
      return { code: a[0], langue: a[1], numero: a[2], texte: a[3], bo: a[4], rang, confiance: couverture(index.docs[i], cs) };
    }).sort((a, b) => b.confiance - a.confiance || a.rang - b.rang).slice(0, topK);

    const confiance = resultats.length ? resultats[0].confiance : 0;
    const niveau = confiance >= SEUIL_ELEVEE ? "elevee" : confiance >= SEUIL_CONFIANCE ? "moyenne" : "faible";
    return {
      langue, pont, formulationArabe, confiance, niveau,
      decision: confiance >= SEUIL_CONFIANCE ? "articles" : "orientation",
      concepts: cs.map((c) => c.mot),
      resultats,
      jetons: { origine: f1.length, arabe: f2.length },
      ms: Math.round(performance.now() - t0),
    };
  }

  const api = { normaliser, jetons, jetonsQuestion, pontBilingue, construireIndex, rechercher, SEUIL_CONFIANCE, SEUIL_ELEVEE };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else racine.Mizan = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
