-- Per-shop preference for the product-card layout in the storefront
-- chat widget. Default "horizontal" preserves the legacy layout for
-- every existing shop on rollout. "showcase" opts in to the square-
-- image, scroll-snap row layout with up to 10 cards.

ALTER TABLE "ShopConfig" ADD COLUMN "productCardStyle" TEXT NOT NULL DEFAULT 'horizontal';
