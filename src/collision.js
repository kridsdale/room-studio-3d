// Exact 2D OBB SAT collision, non-rectangular 5-wall room clamping/snapping,
// door swing, closet clearance, and window light-obstruction checks.
// Coordinates in inches relative to main room center:
// Main room X in [-widthIn/2, +widthIn/2] (West -> East)
// Room Z in [-lengthIn/2, +lengthIn/2] (North -> South)
// SW angled wall flares outward from (-widthIn/2, +lengthIn/2 - swFlareLengthIn)
// to (-widthIn/2 - swFlareWidthIn, +lengthIn/2) between bookcase and entry door.

export function getRoomPolygon(room) {
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const flareW = room.swFlareWidthIn || 0;
  const flareL = room.swFlareLengthIn || 0;
  return [
    { x: -halfW, z: -halfL },                       // NW
    { x: halfW, z: -halfL },                        // NE
    { x: halfW, z: halfL },                         // SE
    { x: -halfW - flareW, z: halfL },               // SW (flared entry corner)
    { x: -halfW, z: halfL - flareL },               // W_KINK (bookcase inflection point)
  ];
}

export function getWestWallXAtZ(z, room) {
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const flareW = room.swFlareWidthIn || 0;
  const flareL = room.swFlareLengthIn || 0;
  const kinkZ = halfL - flareL;
  if (flareW <= 0 || flareL <= 0 || z <= kinkZ) {
    return -halfW;
  }
  const t = Math.min(1, Math.max(0, (z - kinkZ) / flareL));
  return -halfW - flareW * t;
}

export function getRoomFloorAreaSqIn(room) {
  const flareW = room.swFlareWidthIn || 0;
  const flareL = room.swFlareLengthIn || 0;
  return room.widthIn * room.lengthIn + 0.5 * flareW * flareL;
}

export function getItemDimensionsIn(item, catalogEntry) {
  const w = catalogEntry.w;
  const d = item.expanded && catalogEntry.expandedD ? catalogEntry.expandedD : catalogEntry.d;
  const h = catalogEntry.h;
  return { w, d, h };
}

export function getOBBCorners(x, z, w, d, rotDeg) {
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = w / 2;
  const hd = d / 2;
  const local = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  return local.map(([lx, lz]) => ({
    x: x + lx * cos + lz * sin,
    z: z - lx * sin + lz * cos,
  }));
}

export function getOBBAABB(corners) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const c of corners) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.z < minZ) minZ = c.z;
    if (c.z > maxZ) maxZ = c.z;
  }
  return { minX, maxX, minZ, maxZ };
}

function projectCorners(corners, ax, az) {
  let min = Infinity, max = -Infinity;
  for (const c of corners) {
    const p = c.x * ax + c.z * az;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max];
}

export function obbsIntersect(cornersA, cornersB, margin = -0.35) {
  const polys = [cornersA, cornersB];
  for (const poly of polys) {
    for (let i = 0; i < 4; i++) {
      const p1 = poly[i];
      const p2 = poly[(i + 1) % 4];
      const dx = p2.x - p1.x;
      const dz = p2.z - p1.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      const ax = -dz / len;
      const az = dx / len;
      const [minA, maxA] = projectCorners(cornersA, ax, az);
      const [minB, maxB] = projectCorners(cornersB, ax, az);
      if (maxA + margin <= minB || maxB + margin <= minA) {
        return false;
      }
    }
  }
  return true;
}

// Compute minimum signed X distance from any OBB corner to the West (straight + angled) boundary
function getMinWestClearance(corners, room) {
  let minGap = Infinity;
  for (const c of corners) {
    const wallX = getWestWallXAtZ(c.z, room);
    const gap = c.x - wallX;
    if (gap < minGap) minGap = gap;
  }
  return minGap;
}

export function clampAndSnapToRoom(x, z, w, d, rotDeg, room, options = {}) {
  const { gridSnapIn = 1, wallSnap = true } = options;
  let nx = x;
  let nz = z;

  if (gridSnapIn > 0) {
    nx = Math.round(nx / gridSnapIn) * gridSnapIn;
    nz = Math.round(nz / gridSnapIn) * gridSnapIn;
  }

  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;

  // Wall magnet snap (within 3.5" of any of the 5 walls)
  const snapDist = wallSnap ? 3.5 : 0;
  if (wallSnap) {
    const corners = getOBBCorners(nx, nz, w, d, rotDeg);
    const aabb = getOBBAABB(corners);
    const westGap = getMinWestClearance(corners, room);

    if (Math.abs(westGap) < snapDist) {
      nx -= westGap;
    } else if (Math.abs(halfW - aabb.maxX) < snapDist) {
      nx += halfW - aabb.maxX;
    }
    if (Math.abs(aabb.minZ - (-halfL)) < snapDist) {
      nz += -halfL - aabb.minZ;
    } else if (Math.abs(halfL - aabb.maxZ) < snapDist) {
      nz += halfL - aabb.maxZ;
    }
  }

  // Hard clamp inside 5-sided room bounds (Z first, then East & angled/straight West)
  let c2 = getOBBCorners(nx, nz, w, d, rotDeg);
  let a2 = getOBBAABB(c2);
  if (a2.minZ < -halfL) nz += -halfL - a2.minZ;
  if (a2.maxZ > halfL) nz += halfL - a2.maxZ;

  c2 = getOBBCorners(nx, nz, w, d, rotDeg);
  a2 = getOBBAABB(c2);
  if (a2.maxX > halfW) nx += halfW - a2.maxX;

  c2 = getOBBCorners(nx, nz, w, d, rotDeg);
  const westGap2 = getMinWestClearance(c2, room);
  if (westGap2 < 0) {
    nx -= westGap2;
  }

  return { x: nx, z: nz };
}

export function checkPlacementStatus(candidate, allItems, catalogMap, room) {
  const cat = catalogMap[candidate.catalogId];
  const { w, d } = getItemDimensionsIn(candidate, cat);
  const corners = getOBBCorners(candidate.x, candidate.z, w, d, candidate.rotDeg);
  const aabb = getOBBAABB(corners);
  const halfW = room.widthIn / 2;
  const halfL = room.lengthIn / 2;
  const flareW = room.swFlareWidthIn || 0;
  const westClear = getMinWestClearance(corners, room);

  const warnings = [];
  let colliding = false;

  // Surface stacking check (e.g., FADO globe lamp sitting on a desk, nightstand, dresser, KALLAX, BESTÅ!)
  let elevationIn = 0;
  let supportedBy = null;
  let supportUid = null;
  if (cat.stackable) {
    const sup = findSupportingSurface(candidate, allItems, catalogMap);
    if (sup) {
      elevationIn = sup.elevationIn;
      supportedBy = sup.supportedBy;
      supportUid = sup.supportUid;
    }
  }

  // 1. 5-Wall overflow check
  if (
    westClear < -0.5 ||
    aabb.maxX > halfW + 0.5 ||
    aabb.minZ < -halfL - 0.5 ||
    aabb.maxZ > halfL + 0.5
  ) {
    colliding = true;
    warnings.push('Extends past room wall');
  }

  // 2. Furniture-to-furniture OBB collision (respects surface stacking & wall-mounted elevation!)
  if (!cat.isRug) {
    for (const other of allItems) {
      if (other.uid === candidate.uid) continue;
      if (supportUid && other.uid === supportUid) continue;
      const oCat = catalogMap[other.catalogId];
      if (!oCat || oCat.isRug) continue;
      // Wall-mounted items clear low floor furniture; only collide with other wall-mounted or tall pieces reaching mountHeightIn!
      const myMount = candidate.mountHeightIn ?? cat.mountHeightIn ?? 54;
      const otherMount = other.mountHeightIn ?? oCat.mountHeightIn ?? 54;
      if (cat.wallMounted && !oCat.wallMounted && (oCat.h || 0) < myMount) continue;
      if (oCat.wallMounted && !cat.wallMounted && (cat.h || 0) < otherMount) continue;
      if (cat.wallMounted && oCat.wallMounted) {
        const myTop = myMount + (cat.h || 14);
        const oTop = otherMount + (oCat.h || 14);
        if (myTop <= otherMount + 0.5 || oTop <= myMount + 0.5) continue;
      }
      // Stackable tabletop item resting on a surface clears that surface & other floor items below it
      if (oCat.stackable && cat.isSurface) {
        const oSup = findSupportingSurface(other, allItems, catalogMap);
        if (oSup && oSup.supportUid === candidate.uid) continue;
      }
      const oDim = getItemDimensionsIn(other, oCat);
      const oCorners = getOBBCorners(other.x, other.z, oDim.w, oDim.d, other.rotDeg);
      if (obbsIntersect(corners, oCorners)) {
        colliding = true;
        warnings.push(`Overlaps ${oCat.name}`);
      }
    }
  }

  // 3. Entry door inward swing clearance (anchored at flared SW corner hinge; skipped for rugs & elevated wall cubes!)
  if (!cat.isRug && !cat.wallMounted && !supportedBy) {
    const swCornerX = -halfW - flareW;
    const hingeX = swCornerX + room.entryDoorOffsetFromWestIn;
    const doorBox = [
      { x: swCornerX, z: halfL - room.entryDoorWidthIn - 2 },
      { x: hingeX + room.entryDoorWidthIn, z: halfL - room.entryDoorWidthIn - 2 },
      { x: hingeX + room.entryDoorWidthIn, z: halfL },
      { x: swCornerX, z: halfL },
    ];
    if (obbsIntersect(corners, doorBox, -0.5)) {
      warnings.push('Blocks entry door swing');
    }

    // 4. Closet bi-fold door clearance (SE South wall, 15" swing-out depth)
    const closetRightX = halfW - room.closetOffsetFromEastIn;
    const closetLeftX = closetRightX - room.closetWidthIn;
    const closetBox = [
      { x: closetLeftX, z: halfL - 15 },
      { x: closetRightX, z: halfL - 15 },
      { x: closetRightX, z: halfL },
      { x: closetLeftX, z: halfL },
    ];
    if (obbsIntersect(corners, closetBox, -0.5)) {
      warnings.push('Blocks closet bi-fold doors');
    }
  }

  // 5. Window light-obstruction check for tall or wall-mounted items
  if (!cat.isRug) {
    const myMountH = candidate.mountHeightIn ?? cat.mountHeightIn ?? 54;
    const topH = (cat.wallMounted ? myMountH : elevationIn) + (cat.h || 0);
    if (room.northWindow && topH > room.northWindow.sillIn + 6) {
      const nwX0 = -halfW + room.northWindow.offsetFromWestIn;
      const nwX1 = nwX0 + room.northWindow.widthIn;
      if (aabb.minZ < -halfL + 10 && aabb.maxX > nwX0 + 4 && aabb.minX < nwX1 - 4) {
        warnings.push('Blocks North window light');
      }
    }
    if (room.eastWindow && topH > room.eastWindow.sillIn + 6) {
      const ewZ1 = halfL - room.eastWindow.offsetFromSouthIn;
      const ewZ0 = ewZ1 - room.eastWindow.widthIn;
      if (aabb.maxX > halfW - 10 && aabb.maxZ > ewZ0 + 4 && aabb.minZ < ewZ1 - 4) {
        warnings.push('Blocks East window light');
      }
    }
  }

  // 6. Walkway Clearance Pinch-Point Warning (< 28" across main room aisle, e.g. pulled-out King bed vs. desk!)
  const isMajorAislePiece = (it, c) =>
    !c.isRug &&
    !c.wallMounted &&
    !c.stackable &&
    (c.category === 'beds' || it.expanded || c.meshType === 'sofa' || c.meshType === 'sectional');

  if (!colliding && isMajorAislePiece(candidate, cat)) {
    for (const other of allItems) {
      if (other.uid === candidate.uid) continue;
      const oCat = catalogMap[other.catalogId];
      if (!oCat || oCat.isRug || oCat.wallMounted || oCat.stackable) continue;
      if (oCat.meshType === 'coffee_rect' || oCat.meshType === 'coffee_round' || oCat.meshType === 'side_table' || oCat.meshType === 'nightstand' || oCat.isLamp || oCat.meshType === 'plant') continue;
      const oDim = getItemDimensionsIn(other, oCat);
      const oAabb = getOBBAABB(getOBBCorners(other.x, other.z, oDim.w, oDim.d, other.rotDeg));
      const zOverlap = Math.min(aabb.maxZ, oAabb.maxZ) - Math.max(aabb.minZ, oAabb.minZ);
      const xGap = Math.max(oAabb.minX - aabb.maxX, aabb.minX - oAabb.maxX);
      // Flag true cross-aisle squeeze (between 4" and 26" wide over >= 18" of shared N-S length)
      if (zOverlap >= 18 && xGap >= 4 && xGap < 26) {
        warnings.push(`Tight walkway (${Math.round(xGap)}" < 28") near ${oCat.name}`);
        break;
      }
    }
  }

  // 7. Distance to all walls (using exact angled West wall distance at item Z)
  const distances = {
    west: Math.max(0, westClear),
    east: Math.max(0, halfW - aabb.maxX),
    north: Math.max(0, aabb.minZ - (-halfL)),
    south: Math.max(0, halfL - aabb.maxZ),
  };

  return {
    colliding,
    warningOnly: !colliding && warnings.length > 0,
    warnings,
    distances,
    aabb,
    elevationIn,
    supportedBy,
    supportUid,
  };
}

// Find highest tabletop/credenza surface directly under a stackable item's center
export function findSupportingSurface(candidate, allItems, catalogMap) {
  let best = null;
  for (const other of allItems) {
    if (other.uid === candidate.uid) continue;
    const oCat = catalogMap[other.catalogId];
    if (!oCat || !oCat.isSurface) continue;
    const oDim = getItemDimensionsIn(other, oCat);
    const rad = (-other.rotDeg * Math.PI) / 180;
    const dx = candidate.x - other.x;
    const dz = candidate.z - other.z;
    const lx = dx * Math.cos(rad) + dz * Math.sin(rad);
    const lz = -dx * Math.sin(rad) + dz * Math.cos(rad);
    if (Math.abs(lx) <= oDim.w / 2 - 1 && Math.abs(lz) <= oDim.d / 2 - 1) {
      if (!best || oCat.h > best.elevationIn) {
        best = { elevationIn: oCat.h, supportedBy: oCat.name, supportUid: other.uid };
      }
    }
  }
  return best;
}
