// Live IKEA Renton, WA (Store #488) Inventory Lookup & Dimension/3D-Mesh Auto-Mapper
// Works identically in the browser (CORS Access-Control-Allow-Origin: *) and Node.js sync script.

export const RENTON_STORE_NO = '488';
export const RENTON_STORE_NAME = 'IKEA Renton, WA';

// Parse IKEA US imperial measurement strings like:
//   '31 1/2x11x79 1/2 "'  -> { w: 31.5, d: 11, h: 79.5 }
//   '55 1/8x29 1/2 "'      -> { w: 55.1, d: 29.5 }
//   '5 \' 3 "x7 \' 7 "'    -> { w: 63, d: 91 }
//   '7 \' 10 "x10 \''      -> { w: 94, d: 120 }
//   '10 "'                 -> { dia: 10 }
function parseFractionToken(str) {
  const s = String(str || '').trim();
  if (!s) return NaN;
  // Feet + optional inches: e.g. 5 ' 3 " or 10 '
  const ftMatch = s.match(/^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)(?:\s+(\d+)\s*\/\s*(\d+))?)?/);
  if (ftMatch) {
    let inches = parseFloat(ftMatch[1]) * 12;
    if (ftMatch[2]) inches += parseFloat(ftMatch[2]);
    if (ftMatch[3] && ftMatch[4]) inches += parseFloat(ftMatch[3]) / parseFloat(ftMatch[4]);
    return inches;
  }
  // Mixed fraction: 31 1/2
  const mixed = s.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)/);
  if (mixed) return parseFloat(mixed[1]) + parseFloat(mixed[2]) / parseFloat(mixed[3]);
  // Simple fraction: 3/4
  const frac = s.match(/^(\d+)\s*\/\s*(\d+)/);
  if (frac) return parseFloat(frac[1]) / parseFloat(frac[2]);
  // Plain decimal / integer
  const num = s.match(/^(\d+(?:\.\d+)?)/);
  if (num) return parseFloat(num[1]);
  return NaN;
}

export function parseIkeaMeasureText(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();

  // Standard US mattress/bed keywords
  if (low === 'twin' || low.includes('twin')) return { bedSize: 'twin', w: 41, d: 78 };
  if (low === 'full' || low === 'full/double') return { bedSize: 'full', w: 59, d: 78 };
  if (low === 'queen') return { bedSize: 'queen', w: 66, d: 83 };
  if (low === 'king') return { bedSize: 'king', w: 82, d: 83 };

  // Split by 'x' or '×'
  const clean = raw.replace(/×/g, 'x').replace(/[”“″]/g, '"').replace(/[’′]/g, "'");
  const parts = clean.split(/\s*x\s*/i).map((p) => p.replace(/"/g, '').trim()).filter(Boolean);
  const nums = parts.map(parseFractionToken).filter((n) => Number.isFinite(n) && n > 0.5 && n < 240);

  if (nums.length >= 3) {
    return { w: +(nums[0].toFixed(1)), d: +(nums[1].toFixed(1)), h: +(nums[2].toFixed(1)), count: 3 };
  }
  if (nums.length === 2) {
    return { w: +(nums[0].toFixed(1)), d: +(nums[1].toFixed(1)), count: 2 };
  }
  if (nums.length === 1) {
    return { single: +(nums[0].toFixed(1)), count: 1 };
  }
  return null;
}

export function mapIkeaColorToFinish(colors) {
  const first = Array.isArray(colors) && colors.length > 0 ? colors[0] : null;
  const name = String(first?.name || '').toLowerCase();
  const hex = String(first?.hex || '').toLowerCase();
  if (name.includes('white') || hex === 'ffffff') return 'white';
  if (name.includes('black') || hex === '000000') return 'matteBlack';
  if (name.includes('dark gray') || name.includes('dark grey') || name.includes('anthracite')) return 'darkGrey';
  if (name.includes('gray') || name.includes('grey')) return 'lightGrey';
  if (name.includes('blue')) return 'slateBlue';
  if (name.includes('green')) return 'sage';
  if (name.includes('beige') || name.includes('natural')) return 'beige';
  if (name.includes('red') || name.includes('orange') || name.includes('pink')) return 'terracotta';
  if (name.includes('brown') || name.includes('walnut')) return 'walnut';
  if (name.includes('oak') || name.includes('yellow') || name.includes('birch') || name.includes('pine')) return 'oak';
  return 'white';
}

export function formatArticleNo(itemNo) {
  const digits = String(itemNo || '').replace(/\D/g, '');
  if (digits.length === 8) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6)}`;
  }
  return String(itemNo || '');
}

// Infer Room Studio category, procedural 3D meshType, surface/stackable flags, and missing dimensions
export function mapIkeaProductToCatalogItem(prod, forcedCategory = null) {
  if (!prod || !prod.itemNo) return null;
  const name = String(prod.name || 'IKEA Item').trim();
  const typeName = String(prod.typeName || '').trim();
  const primary = `${name} ${typeName}`.toLowerCase();
  const leafCat = String(prod.categoryPath?.[prod.categoryPath.length - 1]?.name || '').toLowerCase();
  const parsed = parseIkeaMeasureText(prod.itemMeasureReferenceText);

  let category = forcedCategory || 'storage';
  let meshType = 'dresser_tall';
  let w = 31.5;
  let d = 16;
  let h = 30;
  let isSurface = false;
  let stackable = false;
  let wallMounted = false;
  let mountHeightIn = 0;
  let isRug = false;
  let isLamp = false;
  let expandable = false;
  let expandedD = null;

  // Classify on specific product name + typeName first; only check leaf category as fallback
  // so umbrella parents like "Desks & desk chairs" never misclassify desks as chairs!
  const classify = (text) => {
    if (/rug|mat\b/.test(text) && !/desk mat|bath mat|door mat|chair mat/.test(text)) {
      category = 'rugs';
      meshType = /jute|flatwoven|sisal/.test(text) ? 'rug_woven' : 'rug';
      isRug = true;
      w = parsed?.w || 52;
      d = parsed?.d || 77;
      h = 0.5;
      return true;
    }
    if (/floor lamp|uplighter|reading lamp/.test(text)) {
      category = 'lighting';
      meshType = 'floor_lamp';
      isLamp = true;
      w = parsed?.single && parsed.single <= 24 ? parsed.single : 14;
      d = w;
      h = parsed?.single && parsed.single > 30 ? parsed.single : 62;
      return true;
    }
    if (/table lamp|work lamp|desk lamp|mood lamp|fado/.test(text)) {
      category = 'lighting';
      meshType = 'orb_lamp';
      isLamp = true;
      stackable = true;
      w = parsed?.single && parsed.single <= 18 ? parsed.single : 10;
      d = w;
      h = parsed?.h || Math.max(10, w);
      return true;
    }
    if (/artificial.*plant|potted plant|fejka/.test(text)) {
      category = 'lighting';
      meshType = 'plant';
      w = 13;
      d = 13;
      h = 36;
      return true;
    }
    if (/daybed|day-bed/.test(text)) {
      category = 'beds';
      meshType = 'daybed';
      w = parsed?.w && parsed.w > 60 ? parsed.w : 79;
      d = parsed?.d && parsed.d < 50 ? parsed.d : 41;
      h = parsed?.h || 33;
      expandable = true;
      expandedD = 64;
      return true;
    }
    if (/loft bed|bunk bed|kura/.test(text)) {
      category = 'beds';
      meshType = 'kura_bed';
      w = parsed?.w || 41;
      d = parsed?.d || 78;
      h = parsed?.h || 46;
      return true;
    }
    if (/bed frame|stackable bed|bed,/.test(text) && !/daybed|sofa/.test(text)) {
      category = 'beds';
      meshType = 'bed';
      w = parsed?.w || 60;
      d = parsed?.d || 78;
      h = parsed?.h || 39;
      return true;
    }
    if (/office chair|swivel chair|gaming chair|desk chair|conference chair/.test(text)) {
      category = 'seating';
      meshType = 'office_chair';
      w = 24.5;
      d = 24.5;
      h = 46;
      return true;
    }
    if (/sectional|corner sofa/.test(text)) {
      category = 'seating';
      meshType = 'sectional';
      w = parsed?.w || 90;
      d = parsed?.d || 59;
      h = parsed?.h || 33;
      return true;
    }
    if (/sleeper sofa|sofa-bed|sofa bed|loveseat|sofa/.test(text)) {
      category = 'seating';
      meshType = 'sofa';
      const is2Seat = /2-seat|loveseat|compact|fridhult|lycksele/.test(text);
      w = parsed?.w || (is2Seat ? 70 : 84);
      d = parsed?.d || 36;
      h = parsed?.h || 33;
      if (/sleeper|sofa-bed|sofa bed/.test(text)) {
        expandable = true;
        expandedD = 58;
      }
      return true;
    }
    if (/wing chair|strandmon/.test(text)) {
      category = 'seating';
      meshType = 'wingchair';
      w = 32;
      d = 38;
      h = 40;
      return true;
    }
    if (/armchair|poäng|poang|accent chair|lounge chair/.test(text)) {
      category = 'seating';
      meshType = 'poang';
      w = 28;
      d = 32;
      h = 37;
      return true;
    }
    if (/desk|sit\/stand|workstation/.test(text) && !/desk lamp|desk mat|desk organizer|desk pad|desk chair/.test(text)) {
      category = 'tables';
      meshType = 'ikea_desk';
      isSurface = true;
      // Corner workstation with hutch often reports WxH (e.g. 39 3/8 x 55 7/8 ")
      if (/corner workstation/.test(text) && parsed?.count === 2 && parsed.d >= 45) {
        w = parsed.w;
        d = parsed.w;
        h = parsed.d;
      } else {
        w = parsed?.w || 47.2;
        d = parsed?.d || 23.6;
        h = parsed?.h || 29.5;
      }
      return true;
    }
    if (/nightstand|bedside table/.test(text)) {
      category = 'tables';
      meshType = 'nightstand';
      isSurface = true;
      w = parsed?.w || 18;
      d = parsed?.d || 15;
      h = parsed?.h || 22;
      return true;
    }
    if (/coffee table/.test(text)) {
      category = 'tables';
      const isRound = /round|circular/.test(text) || parsed?.count === 1;
      meshType = isRound ? 'coffee_round' : 'coffee_rect';
      isSurface = true;
      if (isRound) {
        w = parsed?.single || parsed?.w || 35;
        d = w;
      } else {
        w = parsed?.w || 35.5;
        d = parsed?.d || 21.6;
      }
      h = parsed?.h || 18;
      return true;
    }
    if (/side table|end table/.test(text)) {
      category = 'tables';
      meshType = 'side_table';
      isSurface = true;
      w = parsed?.w || parsed?.single || 18;
      d = parsed?.d || w;
      h = parsed?.h || 19;
      return true;
    }
    if (/wall shelf|wall cabinet|floating shelf|eket.*wall/.test(text)) {
      category = 'storage';
      meshType = 'eket_wall';
      wallMounted = true;
      mountHeightIn = 54;
      w = parsed?.w || 27.5;
      d = parsed?.d || 11;
      h = parsed?.h || 13.7;
      return true;
    }
    if (/bookcase|bookshelf|billy/.test(text)) {
      category = 'storage';
      meshType = 'billy';
      w = parsed?.w || 31.5;
      d = parsed?.d || 11;
      h = parsed?.h || 79.5;
      if (h <= 45) isSurface = true;
      return true;
    }
    if (/kallax|cube|shelving unit/.test(text)) {
      category = 'storage';
      meshType = 'kallax';
      w = parsed?.w || 57.8;
      d = parsed?.d || 15.4;
      h = parsed?.h || 30.2;
      if (h <= 42) isSurface = true;
      return true;
    }
    if (/tv unit|tv bench|tv stand|media|bestå|besta/.test(text)) {
      category = 'storage';
      meshType = 'besta';
      isSurface = true;
      w = parsed?.w || 47.2;
      d = parsed?.d || 15.7;
      h = parsed?.h || 25.2;
      return true;
    }
    if (/wardrobe|armoire|pax/.test(text)) {
      category = 'storage';
      meshType = 'wardrobe';
      w = parsed?.w || 39.4;
      d = parsed?.d || 23.6;
      h = parsed?.h || 79.2;
      return true;
    }
    if (/trofast|toy storage/.test(text)) {
      category = 'storage';
      meshType = 'trofast';
      isSurface = true;
      w = parsed?.w || 36.6;
      d = parsed?.d || 17.3;
      h = parsed?.h || 20.5;
      return true;
    }
    if (/helmer|rolling.*drawer|file cabinet/.test(text)) {
      category = 'storage';
      meshType = 'helmer';
      isSurface = true;
      w = parsed?.w || 11;
      d = parsed?.d || 16.5;
      h = parsed?.h || 27.1;
      return true;
    }
    if (/alex|drawer unit/.test(text)) {
      category = 'storage';
      meshType = 'alex';
      isSurface = true;
      // IKEA ALEX / MICKE drawers often list WxH (14 1/8 x 27 1/2 ") without depth!
      if (parsed?.count === 2 && parsed.w <= 20 && parsed.d >= 24) {
        w = parsed.w;
        h = parsed.d;
        d = 22.8;
      } else {
        w = parsed?.w || 14.1;
        d = parsed?.d || 22.8;
        h = parsed?.h || 27.5;
      }
      return true;
    }
    if (/tonstad/.test(text) && /cabinet|bookcase|storage|sideboard|dresser|shelving/.test(text)) {
      category = 'storage';
      w = parsed?.w || 32.1;
      d = parsed?.d || 14.6;
      h = parsed?.h || 47.25;
      isSurface = h <= 50;
      if (h >= 72 && d >= 17) {
        meshType = 'tonstad_hutch';
      } else {
        meshType = 'tonstad_cabinet';
      }
      return true;
    }
    if (/idan[äa]s/.test(text) && /cabinet|sideboard|bookcase|storage/.test(text)) {
      category = 'storage';
      meshType = 'idanas_cabinet';
      w = parsed?.w || 31.9;
      d = parsed?.d || 15.4;
      h = parsed?.h || 83.1;
      isSurface = h <= 45;
      return true;
    }
    if (/dresser|chest of.*drawer|cabinet|sideboard/.test(text)) {
      category = 'storage';
      isSurface = true;
      // IKEA US dressers often report WxH (e.g., "31 1/2x30 3/4 \"") when 2 numbers!
      if (parsed?.count === 2 && parsed.d >= 26) {
        w = parsed.w;
        h = parsed.d;
        d = 19;
      } else {
        w = parsed?.w || 31.5;
        d = parsed?.d || 19;
        h = parsed?.h || 31;
      }
      meshType = w >= 48 ? 'dresser_wide' : 'dresser_tall';
      return true;
    }
    if (/table/.test(text) && !/table lamp|tablecloth|table runner/.test(text)) {
      category = 'tables';
      meshType = 'ikea_desk';
      isSurface = true;
      w = parsed?.w || 47.2;
      d = parsed?.d || 29.5;
      h = parsed?.h || 29.5;
      return true;
    }
    return false;
  };

  if (!classify(primary) && !(leafCat && classify(leafCat))) {
    // Fallback generic furniture box
    category = forcedCategory || 'storage';
    meshType = 'dresser_tall';
    w = parsed?.w || 28;
    d = parsed?.d || 16;
    h = parsed?.h || 30;
    if (h <= 42) isSurface = true;
  }

  // Clamp sanity bounds so malformed measurement strings never spawn giant blocks
  w = Math.max(8, Math.min(115, +Number(w).toFixed(1)));
  d = Math.max(6, Math.min(130, +Number(d).toFixed(1)));
  h = Math.max(0.5, Math.min(94, +Number(h).toFixed(1)));

  const avail = Array.isArray(prod.availability)
    ? prod.availability.find((a) => a.type2 === 'CASH_AND_CARRY') || prod.availability[0]
    : null;
  const rentonStock = avail?.status || 'UNKNOWN';
  const priceNum = Math.round(Number(prod.salesPrice?.numeral) || 0);
  const prevPrice = prod.salesPrice?.previous?.wholeNumber
    ? Number(String(prod.salesPrice.previous.wholeNumber).replace(/,/g, ''))
    : null;
  const finish = mapIkeaColorToFinish(prod.colors);
  const finishes = Array.from(new Set([finish, 'white', 'oak', 'blackBrown', 'darkGrey'])).slice(0, 4);

  const imgUrl = prod.mainImageUrl
    ? prod.mainImageUrl.includes('?')
      ? prod.mainImageUrl
      : `${prod.mainImageUrl}?f=xxs`
    : null;

  const id = `renton_${String(prod.itemNo).replace(/[^a-zA-Z0-9]/g, '')}`;
  const measureHint = prod.itemMeasureReferenceText ? ` · ${prod.itemMeasureReferenceText.trim()}` : '';

  return {
    id,
    name: `${name}`,
    brand: 'IKEA',
    category,
    price: priceNum,
    prevPrice: prevPrice && prevPrice > priceNum ? prevPrice : null,
    priceTag: prod.salesPrice?.tagText || null,
    w,
    d,
    h,
    defaultFinish: finish,
    finishes,
    meshType,
    subtitle: `${typeName || 'IKEA Furniture'}${measureHint}`,
    itemNo: String(prod.itemNo),
    skuFormatted: formatArticleNo(prod.itemNo),
    pipUrl: prod.pipUrl || null,
    imageUrl: imgUrl,
    rentonStock,
    isSurface,
    stackable,
    wallMounted,
    ...(wallMounted ? { mountHeightIn } : {}),
    ...(isRug ? { isRug: true } : {}),
    ...(isLamp ? { isLamp: true } : {}),
    ...(expandable ? { expandable: true, expandedD } : {}),
    ...(meshType === 'kallax' ? { cols: w >= 50 ? 4 : 2, rows: h >= 50 ? 4 : 2 } : {}),
    ...(meshType === 'billy' ? { bays: w >= 50 ? 2 : 1 } : {}),
    liveRenton: true,
  };
}

// Live browser/Node query against IKEA Renton, WA (#488)
export async function searchLiveRentonInventory(query, opts = {}) {
  const { size = 36, inStockOnly = true, signal } = opts;
  const q = String(query || '').trim();
  if (!q) return { items: [], totalMatched: 0 };

  const url = `https://sik.search.blue.cdtapps.com/us/en/search-result-page?q=${encodeURIComponent(q)}&size=${Math.min(100, size)}&c=sr&store=${RENTON_STORE_NO}`;
  const res = await fetch(url, { signal });
  if (!res.ok) {
    throw new Error(`IKEA Renton lookup returned HTTP ${res.status}`);
  }
  const data = await res.json();
  const prodsWrap = data?.searchResultPage?.products;
  const totalMatched = prodsWrap?.badge || 0;
  const rawItems = prodsWrap?.main?.items || [];

  const mapped = [];
  const seen = new Set();
  for (const row of rawItems) {
    if (row?.type !== 'PRODUCT' || !row.product) continue;
    const item = mapIkeaProductToCatalogItem(row.product);
    if (!item || seen.has(item.itemNo)) continue;
    if (inStockOnly && item.rentonStock !== 'HIGH_IN_STOCK' && item.rentonStock !== 'LOW_IN_STOCK') {
      continue;
    }
    seen.add(item.itemNo);
    mapped.push(item);
  }
  return { items: mapped, totalMatched };
}
