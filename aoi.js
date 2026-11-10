// Izgara tabanlı "Görüş Alanı" (Area of Interest) sistemi.
//
// Harita eşit büyüklükte hücrelere bölünür (örn. 256x256 piksel). Her varlık (oyuncu, canavar,
// yerdeki eşya) bulunduğu hücreye kaydedilir. Bir oyuncuya ne gönderileceğine karar verirken
// bütün dünyayı taramak yerine sadece etrafındaki birkaç hücreye bakılır:
//
//   1000 oyuncu + 2000 canavar olsa bile her oyuncu için ~9-25 hücre taranır.
//   Tüm dünyayı taramak: O(N²)  →  ızgara ile: O(N · yakındakiler)
//
// Aynı ızgara, hasar hesaplarında "bu saldırının menzilinde kim var?" sorusu için de kullanılır.

class SpatialGrid {
  constructor(cellSize) {
    this.cs = cellSize;
    this.cells = new Map(); // hücre anahtarı -> Set(varlık)
    this.where = new Map(); // varlık -> hücre anahtarı
  }

  key(x, y) {
    const cx = Math.floor(x / this.cs), cy = Math.floor(y / this.cs);
    return cx * 100000 + cy;
  }

  insert(e) {
    const k = this.key(e.x, e.y);
    let cell = this.cells.get(k);
    if (!cell) this.cells.set(k, (cell = new Set()));
    cell.add(e);
    this.where.set(e, k);
  }

  remove(e) {
    const k = this.where.get(e);
    if (k === undefined) return;
    const cell = this.cells.get(k);
    if (cell) {
      cell.delete(e);
      if (cell.size === 0) this.cells.delete(k);
    }
    this.where.delete(e);
  }

  // Varlık hareket ettikten sonra çağrılır; hücre değişmediyse hiçbir şey yapmaz (çok ucuz).
  update(e) {
    const k = this.key(e.x, e.y);
    const old = this.where.get(e);
    if (old === k) return;
    if (old !== undefined) this.remove(e);
    this.insert(e);
  }

  // (x, y) merkezli r yarıçaplı daire içindeki varlıklar.
  query(x, y, r, filter) {
    const out = [];
    const cs = this.cs;
    const x0 = Math.floor((x - r) / cs), x1 = Math.floor((x + r) / cs);
    const y0 = Math.floor((y - r) / cs), y1 = Math.floor((y + r) / cs);
    const r2 = r * r;
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const cell = this.cells.get(cx * 100000 + cy);
        if (!cell) continue;
        for (const e of cell) {
          const dx = e.x - x, dy = e.y - y;
          if (dx * dx + dy * dy <= r2 && (!filter || filter(e))) out.push(e);
        }
      }
    }
    return out;
  }

  get size() { return this.where.size; }
}

module.exports = { SpatialGrid };
