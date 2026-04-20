import prisma from "../db.server";

export async function getAttributeMappings(shop) {
  return prisma.attributeMapping.findMany({ where: { shop } });
}

export async function upsertAttributeMapping(
  shop,
  { attribute, sourceType, target, namespace, key, prefix },
) {
  const data = {
    sourceType,
    target: target || "product",
    namespace: namespace || null,
    key: key || null,
    prefix: prefix || null,
  };
  return prisma.attributeMapping.upsert({
    where: { shop_attribute: { shop, attribute } },
    update: { ...data, updatedAt: new Date() },
    create: { shop, attribute, ...data },
  });
}

export async function deleteAttributeMapping(shop, attribute) {
  return prisma.attributeMapping.deleteMany({ where: { shop, attribute } });
}

function filterMetafieldMappings(mappings, target) {
  return mappings.filter(
    (m) =>
      m.sourceType === "metafield" &&
      m.namespace &&
      m.key &&
      (m.target || "product") === target,
  );
}

export function buildMetafieldFragment(mappings, target = "product") {
  const metafieldMappings = filterMetafieldMappings(mappings, target);
  if (metafieldMappings.length === 0) return "";
  return metafieldMappings
    .map(
      (m, i) =>
        `attr_${i}: metafield(namespace: "${m.namespace}", key: "${m.key}") {
          value
          type
          reference { ... on Metaobject { handle displayName } }
          references(first: 10) { nodes { ... on Metaobject { handle displayName } } }
        }`,
    )
    .join("\n        ");
}

export function resolveMetafieldValue(metafield) {
  if (!metafield) return null;

  const refs = metafield.references?.nodes || [];
  if (refs.length > 0) {
    const values = refs
      .map((n) => n?.displayName || n?.handle || "")
      .filter(Boolean)
      .map((v) => v.toLowerCase());
    return values.length === 1 ? values[0] : values;
  }

  const ref = metafield.reference;
  if (ref) {
    return (ref.displayName || ref.handle || "").toLowerCase() || null;
  }

  const raw = metafield.value;
  if (!raw) return null;

  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) {
        const vals = arr
          .map((v) => {
            if (typeof v === "string") {
              if (v.startsWith("gid://")) return null;
              return v.toLowerCase().trim();
            }
            return String(v).toLowerCase().trim();
          })
          .filter(Boolean);
        return vals.length === 1 ? vals[0] : vals.length > 0 ? vals : null;
      }
    } catch {}
  }

  if (trimmed.startsWith("gid://")) return null;
  return trimmed.toLowerCase();
}

export function resolveProductAttributes(node, mappings) {
  if (!mappings || mappings.length === 0) return null;

  const attrs = {};
  const metafieldMappings = filterMetafieldMappings(mappings, "product");
  const tagMappings = mappings.filter((m) => m.sourceType === "tag_prefix" && m.prefix);

  for (let i = 0; i < metafieldMappings.length; i++) {
    const mapping = metafieldMappings[i];
    const mf = node[`attr_${i}`];
    const val = resolveMetafieldValue(mf);
    if (val != null) attrs[mapping.attribute] = val;
  }

  const tags = node.tags || [];
  for (const mapping of tagMappings) {
    const prefix = mapping.prefix.toLowerCase();
    for (const tag of tags) {
      const t = (typeof tag === "string" ? tag : "").toLowerCase().trim();
      if (t.startsWith(prefix)) {
        const val = t.slice(prefix.length).trim();
        if (val) {
          if (attrs[mapping.attribute]) {
            const existing = Array.isArray(attrs[mapping.attribute])
              ? attrs[mapping.attribute]
              : [attrs[mapping.attribute]];
            existing.push(val);
            attrs[mapping.attribute] = existing;
          } else {
            attrs[mapping.attribute] = val;
          }
        }
      }
    }
  }

  return Object.keys(attrs).length > 0 ? attrs : null;
}

export function resolveVariantAttributes(variantNode, mappings) {
  if (!mappings || mappings.length === 0) return null;

  const metafieldMappings = filterMetafieldMappings(mappings, "variant");
  if (metafieldMappings.length === 0) return null;

  const attrs = {};
  for (let i = 0; i < metafieldMappings.length; i++) {
    const mapping = metafieldMappings[i];
    const mf = variantNode[`attr_${i}`];
    const val = resolveMetafieldValue(mf);
    if (val != null) attrs[mapping.attribute] = val;
  }
  return Object.keys(attrs).length > 0 ? attrs : null;
}
