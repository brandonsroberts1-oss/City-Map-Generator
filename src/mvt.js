// A small Mapbox Vector Tile reader.
//
// Vector tiles are the reason the app can draw a city in well under a second:
// they are built ahead of time and served from a CDN, where an Overpass query
// is executed live against the whole planet on a shared machine. The format is
// a compact protobuf, and only the handful of message types below are needed to
// read one — less code than pulling in a general protobuf runtime, and no build
// step, which this project does not have.
//
// Reference: https://github.com/mapbox/vector-tile-spec/tree/master/2.1

class Reader {
  constructor(buffer) {
    this.bytes = new Uint8Array(buffer);
    this.pos = 0;
    this.end = this.bytes.length;
  }

  /** Base-128 varint, little-endian, high bit marking continuation. */
  varint() {
    let value = 0;
    let shift = 0;
    while (this.pos < this.end) {
      const byte = this.bytes[this.pos++];
      value += shift < 28 ? (byte & 0x7f) << shift : (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return value;
      shift += 7;
    }
    return value;
  }

  /** Protobuf zigzag: signed numbers folded onto unsigned ones. */
  svarint() {
    const value = this.varint();
    return value % 2 === 1 ? (value + 1) / -2 : value / 2;
  }

  skip(wireType) {
    if (wireType === 0) this.varint();
    else if (wireType === 2) this.pos += this.varint();
    else if (wireType === 5) this.pos += 4;
    else if (wireType === 1) this.pos += 8;
    else throw new Error(`Unsupported wire type ${wireType}`);
  }

  string(length) {
    const slice = this.bytes.subarray(this.pos, this.pos + length);
    this.pos += length;
    return new TextDecoder('utf-8').decode(slice);
  }

  float32() {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 4).getFloat32(0, true);
    this.pos += 4;
    return value;
  }

  float64() {
    const value = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.pos, 8).getFloat64(0, true);
    this.pos += 8;
    return value;
  }

  /** Runs `fn` over a length-delimited sub-message and restores the position. */
  message(fn) {
    const length = this.varint();
    const end = this.pos + length;
    const outerEnd = this.end;
    this.end = end;
    const result = fn(this);
    this.pos = end;
    this.end = outerEnd;
    return result;
  }

  fields(handle) {
    while (this.pos < this.end) {
      const key = this.varint();
      const field = key >> 3;
      const wireType = key & 0x7;
      if (!handle(field, wireType)) this.skip(wireType);
    }
  }
}

function readValue(reader) {
  let value = null;
  reader.fields((field, wireType) => {
    if (field === 1 && wireType === 2) {
      value = reader.string(reader.varint());
    } else if (field === 2 && wireType === 5) {
      value = reader.float32();
    } else if (field === 3 && wireType === 1) {
      value = reader.float64();
    } else if (field === 4 || field === 5) {
      value = reader.varint();
    } else if (field === 6) {
      value = reader.svarint();
    } else if (field === 7) {
      value = Boolean(reader.varint());
    } else {
      return false;
    }
    return true;
  });
  return value;
}

/**
 * Geometry is a flat stream of commands: MoveTo starts a ring or line, LineTo
 * extends it, ClosePath shuts a ring. Coordinates are deltas from the previous
 * point, zigzag encoded.
 */
function readGeometry(reader) {
  const rings = [];
  let current = null;
  let x = 0;
  let y = 0;
  while (reader.pos < reader.end) {
    const command = reader.varint();
    const id = command & 0x7;
    const count = command >> 3;
    if (id === 1) {
      for (let i = 0; i < count; i++) {
        x += reader.svarint();
        y += reader.svarint();
        current = [[x, y]];
        rings.push(current);
      }
    } else if (id === 2) {
      for (let i = 0; i < count; i++) {
        x += reader.svarint();
        y += reader.svarint();
        if (current) current.push([x, y]);
      }
    } else if (id === 7) {
      if (current && current.length) current.push([current[0][0], current[0][1]]);
      current = null;
    } else {
      break;
    }
  }
  return rings;
}

function readFeature(reader, keys, values) {
  const feature = { id: undefined, type: 0, properties: {}, geometry: [] };
  let tagPairs = null;
  reader.fields((field, wireType) => {
    if (field === 1) {
      feature.id = reader.varint();
    } else if (field === 2 && wireType === 2) {
      tagPairs = reader.message((sub) => {
        const out = [];
        while (sub.pos < sub.end) out.push(sub.varint());
        return out;
      });
    } else if (field === 3) {
      feature.type = reader.varint();
    } else if (field === 4 && wireType === 2) {
      feature.geometry = reader.message(readGeometry);
    } else {
      return false;
    }
    return true;
  });
  if (tagPairs) {
    for (let i = 0; i + 1 < tagPairs.length; i += 2) {
      const key = keys[tagPairs[i]];
      if (key !== undefined) feature.properties[key] = values[tagPairs[i + 1]];
    }
  }
  return feature;
}

function readLayer(reader) {
  const layer = { name: '', extent: 4096, features: [] };
  const keys = [];
  const values = [];
  const rawFeatures = [];
  reader.fields((field, wireType) => {
    if (field === 1 && wireType === 2) {
      layer.name = reader.string(reader.varint());
    } else if (field === 2 && wireType === 2) {
      // Features reference the key and value tables, which may follow them, so
      // their bytes are set aside and decoded once the tables are complete.
      const length = reader.varint();
      rawFeatures.push([reader.pos, reader.pos + length]);
      reader.pos += length;
    } else if (field === 3 && wireType === 2) {
      keys.push(reader.string(reader.varint()));
    } else if (field === 4 && wireType === 2) {
      values.push(reader.message(readValue));
    } else if (field === 5) {
      layer.extent = reader.varint();
    } else {
      return false;
    }
    return true;
  });

  for (const [start, end] of rawFeatures) {
    reader.pos = start;
    reader.end = end;
    layer.features.push(readFeature(reader, keys, values));
  }
  return layer;
}

/**
 * @param {ArrayBuffer|Uint8Array} buffer raw .pbf tile bytes
 * @returns {Object<string, {name: string, extent: number, features: Array}>}
 */
export function decodeTile(buffer) {
  const reader = new Reader(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
  const layers = {};
  reader.fields((field, wireType) => {
    if (field === 3 && wireType === 2) {
      const outerEnd = reader.end;
      const length = reader.varint();
      const end = reader.pos + length;
      reader.end = end;
      const layer = readLayer(reader);
      reader.pos = end;
      reader.end = outerEnd;
      if (layer.name) layers[layer.name] = layer;
      return true;
    }
    return false;
  });
  return layers;
}

export const GEOMETRY_POINT = 1;
export const GEOMETRY_LINE = 2;
export const GEOMETRY_POLYGON = 3;
