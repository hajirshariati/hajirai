import assert from "node:assert/strict";
import { analyzeCategoryIntent, cardMatchesActiveGroup } from "../app/lib/category-intent.server.js";

const groups = [
  {
    name: "Footwear",
    categories: ["Boots", "Clogs", "Footwear", "Loafers", "Mary Janes", "Oxfords", "Sandals", "Slip Ons", "Slippers", "Sneakers", "Wedges Heels"],
    triggers: ["shoe", "shoes", "footwear", "sneaker", "sandal", "boot", "loafer", "slipper", "heel", "flat", "clog", "oxford", "slide", "mule", "wedge", "mary jane", "ballet", "slip on", "running shoes", "gym shoes", "training shoes", "casual shoes", "dress shoes", "walking shoes"],
  },
  {
    name: "Orthotics",
    categories: ["Orthotics"],
    triggers: ["orthotic", "orthotics", "insole", "insert", "footbed", "arch support insert", "plantar fasciitis insert"],
    goesInsideOf: "Footwear",
  },
  {
    name: "Accessories",
    categories: ["Accessories", "Socks", "Gift Card"],
    triggers: ["accessory", "accessories", "sock", "socks", "gift card", "gift", "present"],
  },
];

const u = (content) => ({ role: "user", content });
const a = (content) => ({ role: "assistant", content });

const cases = [
  {
    name: "plain shoes routes to footwear",
    messages: [u("I am 300 pounds, what shoes do I wear?")],
    active: "Footwear",
  },
  {
    name: "gender follow-up preserves footwear",
    messages: [u("I am 300 pounds, what shoes do I wear?"), a("Which styles would you like to browse — men's or women's? <<Men's>><<Women's>>"), u("Men's")],
    active: "Footwear",
  },
  {
    name: "inside shoes implies insert-like product",
    messages: [u("I need something for heel pain that goes inside my shoes.")],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "put in work shoes implies orthotics",
    messages: [u("Looking for things to put in my work shoes.")],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "support inside sneakers implies orthotics",
    messages: [u("My sneakers hurt my arches. Need support inside them.")],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "insoles for loafers keeps insoles active",
    messages: [u("Insoles for loafers?")],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "orthotics for mary janes keeps orthotics active",
    messages: [u("Can I get orthotics for Mary Janes?")],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "socks for boots keeps accessories active",
    messages: [u("I am buying socks for wearing with boots.")],
    active: "Accessories",
    context: "Footwear",
  },
  {
    name: "gift card for orthotics keeps gift card active",
    messages: [u("Can I buy a gift card for orthotics?")],
    active: "Accessories",
    context: "Orthotics",
  },
  {
    name: "gift card for sneaker lover keeps gift card active",
    messages: [u("Do you have gift cards for someone who likes sneakers?")],
    active: "Accessories",
    context: "Footwear",
  },
  {
    name: "supportive oxfords are footwear",
    messages: [u("I need supportive Oxfords.")],
    active: "Footwear",
  },
  {
    name: "mary janes with arch support are footwear",
    messages: [u("Show me Mary Janes with arch support.")],
    active: "Footwear",
  },
  {
    name: "plantar fasciitis plus shoes stays footwear",
    messages: [u("I have plantar fasciitis and need shoes.")],
    active: "Footwear",
  },
  {
    name: "heel pain shoes stays footwear",
    messages: [u("Heel pain shoes, women's.")],
    active: "Footwear",
  },
  {
    name: "orthotic shoes are ambiguous",
    messages: [u("Orthotic shoes for women.")],
    ambiguous: true,
  },
  {
    name: "shoes with orthotic support are ambiguous",
    messages: [u("Shoes with orthotic support.")],
    ambiguous: true,
  },
  {
    name: "not sure shoes or orthotics is ambiguous",
    messages: [u("I'm not sure if I need shoes or orthotics.")],
    ambiguous: true,
  },
  {
    name: "orthotics flow plus running shoes context",
    messages: [
      u("My dad has foot pain, what should he wear inside his shoes?"),
      a("To find the right orthotic, what type of shoes does he wear? <<Running Shoes>><<Casual/Everyday Shoes>>"),
      u("Running Shoes"),
    ],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "railway dad flow preserves orthotics after generic shoe question",
    messages: [
      u("i'm a soccer player, my dad came to soccer with me last week and he is 65 years old, he did fine but now he has a foot pain, what do you recommend he wear inside his shoes for the next match to help him with the pain so he can still play ?"),
      a("Where is your dad's foot pain located? <<Arch / Heel>><<Ball of Foot>><<Both>>"),
      u("Both"),
      a("What type of shoes does your dad wear to the matches? <<Running shoes>><<Casual/Everyday shoes>>"),
      u("Running shoes"),
    ],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "railway dad flow still preserves orthotics after user correction",
    messages: [
      u("i'm a soccer player, my dad came to soccer with me last week and he is 65 years old, he did fine but now he has a foot pain, what do you recommend he wear inside his shoes for the next match to help him with the pain so he can still play ?"),
      a("Where is your dad's foot pain located? <<Arch / Heel>><<Ball of Foot>><<Both>>"),
      u("Both"),
      a("What type of shoes does your dad wear to the matches? <<Running shoes>><<Casual/Everyday shoes>>"),
      u("Running shoes"),
      a("Is your dad's pain more on the arch/heel side, ball of foot, or both areas?"),
      u("i already said, both"),
    ],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "orthotics flow plus oxfords context",
    messages: [
      u("I need inserts for arch pain."),
      a("What shoes should the orthotics fit? <<Mary Janes>><<Oxfords>><<Boots>>"),
      u("Oxfords"),
    ],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "orthotics flow explicit footwear pivot wins",
    messages: [
      u("I need inserts for arch pain."),
      a("What shoes should the orthotics fit? <<Mary Janes>><<Oxfords>><<Boots>>"),
      u("Find sneakers instead."),
    ],
    active: "Footwear",
  },
  {
    name: "bare footwear pivot without contextual prompt switches",
    messages: [
      u("I need orthotics for heel pain."),
      a("The right orthotic depends on where your pain is located."),
      u("Sandals"),
    ],
    active: "Footwear",
  },
  {
    name: "footwear to orthotics pivot switches",
    messages: [u("Show me sneakers."), a("Here are some sneaker options."), u("Actually I need orthotics.")],
    active: "Orthotics",
  },
  {
    name: "accessories to footwear pivot switches",
    messages: [u("I need socks."), a("I can help with socks."), u("Actually shoes for my dad.")],
    active: "Footwear",
  },
  {
    name: "gift card to loafers pivot switches",
    messages: [u("I need a gift card."), a("I can help with gift cards."), u("Never mind, women's loafers.")],
    active: "Footwear",
  },
  {
    name: "boot socks ambiguous without for-context",
    messages: [u("Boot socks?")],
    ambiguous: true,
  },
  {
    name: "boots with socks keeps first product group",
    messages: [u("Do you have boots with good socks?")],
    ambiguous: true,
  },
  {
    name: "shoe replacements not inserts stays footwear",
    messages: [u("My loafers hurt. I want replacement shoes, not insoles.")],
    ambiguous: true,
  },
  {
    name: "walking sneakers for flat feet are footwear",
    messages: [u("Need walking sneakers for flat feet.")],
    active: "Footwear",
  },
  {
    name: "slippers for neuropathy are footwear",
    messages: [u("Need slippers for neuropathy.")],
    active: "Footwear",
  },
  {
    name: "clogs for standing are footwear",
    messages: [u("I want clogs I can stand in all day.")],
    active: "Footwear",
  },
  {
    name: "accessories for sandals are accessories",
    messages: [u("Need accessories for my sandals.")],
    active: "Accessories",
    context: "Footwear",
  },
  {
    name: "replacement socks not shoes stays accessories",
    messages: [u("I need replacement socks, not shoes.")],
    ambiguous: true,
  },
  {
    name: "assistant contextual chips do not become prior active",
    messages: [
      u("I need orthotics for heel pain."),
      a("What type of shoes will you wear them in? <<Running Shoes>><<Casual Shoes>>"),
      u("Running Shoes"),
    ],
    active: "Orthotics",
    context: "Footwear",
  },
  {
    name: "assistant contextual categories do not override prior user goal",
    messages: [
      u("I need a gift card."),
      a("Who is the gift card for? Someone who likes <<Sneakers>> or <<Orthotics>>?"),
      u("Sneakers"),
    ],
    active: "Accessories",
    context: "Footwear",
  },
  {
    name: "card guard allows active category",
    card: { _category: "orthotics" },
    active: "Orthotics",
    cardAllowed: true,
  },
  {
    name: "card guard rejects context category",
    card: { _category: "sneakers" },
    active: "Orthotics",
    cardAllowed: false,
  },
  {
    name: "card guard allows missing category metadata",
    card: { title: "Unknown product" },
    active: "Orthotics",
    cardAllowed: true,
  },
];

let passed = 0;
for (const testCase of cases) {
  const group = testCase.active ? groups.find((g) => g.name === testCase.active) : null;
  if (testCase.card) {
    assert.equal(
      cardMatchesActiveGroup(testCase.card, group),
      testCase.cardAllowed,
      testCase.name,
    );
    passed++;
    continue;
  }

  const actual = analyzeCategoryIntent(testCase.messages, groups);
  assert.equal(Boolean(actual.ambiguous), Boolean(testCase.ambiguous), `${testCase.name}: ambiguous`);
  assert.equal(actual.activeGroup?.name || null, testCase.active || null, `${testCase.name}: active`);
  assert.equal(actual.contextGroup?.name || null, testCase.context || null, `${testCase.name}: context`);
  passed++;
}

console.log(`category-intent eval passed: ${passed}/${cases.length}`);
