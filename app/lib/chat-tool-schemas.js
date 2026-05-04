// Tool schemas for the chat agentic loop. Pure JSON-shaped data —
// no runtime imports, no prisma, no DB. Lives in its own file so
// scripts (eval-e2e.mjs and others) can load just the schemas
// without dragging the whole prisma/embeddings/Shopify import chain.
//
// chat-tools.server.js re-exports these unchanged. Existing imports
// like `import { TOOLS } from "../lib/chat-tools.server"` keep working.
// The new path `import { TOOLS } from "../lib/chat-tool-schemas"` is
// for code that runs outside the React Router bundler context.

export const TOOLS = [
  {
    name: "search_products",
    description:
      "Search the merchant's product catalog by keyword. Returns products matching the query across title, vendor, product type, tags, and description. Use filters to narrow by attributes the merchant has configured (e.g. gender, color, material).",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to search for (e.g. 'running shoes', 'wool sweater', 'waterproof').",
        },
        limit: {
          type: "integer",
          description: "Pool size to fetch from the catalog (default 6, max 10). NOT the number of cards rendered to the customer — the chat layer decides card count from customer intent. Set higher only if you want a larger candidate pool to choose from.",
          minimum: 1,
          maximum: 10,
        },
        filters: {
          type: "object",
          description: "Optional attribute filters. Keys are attribute names (e.g. 'gender', 'color', 'material'), values are the desired value. Only attributes the merchant has mapped will be usable.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_product_details",
    description:
      "Fetch full details for a single product, including all variants, prices, options, and any CSV-enriched data (materials, care, fit notes, etc.). Use this when the customer asks about a specific product or you want to answer a detail question authoritatively.",
    input_schema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The product handle (slug), e.g. 'cotton-crew-tee'.",
        },
      },
      required: ["handle"],
    },
  },
  {
    name: "lookup_sku",
    description:
      "Look up one or more SKUs and return the matching variant, its parent product, and any CSV enrichment data. Use this when the customer mentions a SKU or when you need to verify enrichment data for specific items.",
    input_schema: {
      type: "object",
      properties: {
        skus: {
          type: "array",
          items: { type: "string" },
          description: "List of SKUs to look up. Max 10.",
          maxItems: 10,
        },
      },
      required: ["skus"],
    },
  },
  {
    name: "find_similar_products",
    description:
      "Find products similar to a specific reference product the customer named. Use this WHENEVER the customer asks for styles 'like', 'similar to', 'comparable to', 'supports like', 'feels like', or 'what else is like the <product name>' a specific product they named. Matches on the merchant's configured similarity attributes PLUS category PLUS gender of the reference product. Automatically excludes the reference product itself from results. Supports optional priceMax (when customer asks for 'cheaper', 'under $50', 'less expensive') and query (additional keyword filter, e.g. 'leather' to narrow to leather-only). Do NOT use search_products for this — search_products cannot exclude the reference and cannot guarantee the similarity-attribute match. If the customer names a product but you don't know its handle, call search_products first to get the handle, then call this tool.",
    input_schema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The reference product's handle (slug). This is the product the customer named and wants similar styles to.",
        },
        limit: {
          type: "integer",
          description: "Maximum number of similar products to return (default 6, max 10).",
          minimum: 1,
          maximum: 10,
        },
        priceMax: {
          type: "number",
          description: "Optional maximum price ceiling. Use when the customer says 'cheaper', 'under $X', 'less expensive', 'budget'.",
        },
        query: {
          type: "string",
          description: "Optional keyword filter applied on top of similarity matching. Use for narrowing modifiers: 'leather', 'waterproof', 'wide width', 'memory foam', etc.",
        },
      },
      required: ["handle"],
    },
  },
  {
    name: "get_product_reviews",
    description:
      "Fetch customer reviews from Yotpo for a specific product, including an aggregated fit/sizing summary. Use this whenever the customer asks about fit, sizing (true to size, runs small, runs large), comfort, quality, or wants to know what other buyers think. Returns review count, average rating, fit breakdown, and a sample of the most recent review snippets.",
    input_schema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The product handle (slug), e.g. 'jillian-sandal'.",
        },
      },
      required: ["handle"],
    },
  },
  {
    name: "get_return_insights",
    description:
      "Fetch return/exchange insights from Aftership for a specific product, including how often it gets returned for sizing reasons (too small, too big) and common return reasons. Use this when the customer asks about sizing, fit, whether to size up or down, or return/exchange policy for a specific product.",
    input_schema: {
      type: "object",
      properties: {
        handle: {
          type: "string",
          description: "The product handle (slug), e.g. 'jillian-sandal'.",
        },
      },
      required: ["handle"],
    },
  },
];

export const FIT_PREDICTOR_TOOL = {
  name: "get_fit_recommendation",
  description:
    "Recommend a specific size with a confidence score for a single product, aggregating review fit signals, return sizing data, customer order history, and any merchant-configured external fit API. Use this INSTEAD of get_product_reviews + get_return_insights whenever the customer asks 'what size should I get', 'do these run small', 'should I size up/down', 'fit for [product]', or anything where the answer is a specific size. Returns a structured report that the widget renders as a visual fit-confidence card.",
  input_schema: {
    type: "object",
    properties: {
      handle: {
        type: "string",
        description: "The product handle to recommend a size for.",
      },
      customerSizeHint: {
        type: "string",
        description: "Optional. If the customer mentioned their usual size (e.g. '9', '8.5', 'W9', 'M10.5'), pass it so the predictor can anchor the recommendation.",
      },
    },
    required: ["handle"],
  },
};

export const CUSTOMER_ORDERS_TOOL = {
  name: "get_customer_orders",
  description:
    "Fetch the logged-in customer's order history, including tracking info and delivery status. Call this when the customer asks about their orders, shipping, tracking, delivery, a specific order number, past purchases, or reorder. Returns order number, date, status, line items, total, tracking numbers with carrier and URL, and estimated/actual delivery date. Never exposes email, street addresses, or payment info. If the customer mentions a specific order number, pass it as orderNumber to filter.",
  input_schema: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Number of recent orders to fetch. Default 5, max 10.",
        minimum: 1,
        maximum: 10,
      },
      orderNumber: {
        type: "string",
        description: "Optional. A specific order number the customer mentioned (e.g. '1023' or '#1023'). If provided, only matching orders are returned. If the match is empty, the tool returns an empty orders array (order may be too old or doesn't belong to this customer).",
      },
    },
  },
};
