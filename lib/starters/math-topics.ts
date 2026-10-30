// Topic taxonomy helpers for math diagnosis. The ids themselves live in
// lib/starters/types.ts (MATH_TOPICS); this file adds the one-line hints the
// prompt embeds so the model picks a topic from the same list the weak-spot
// tracker counts, plus the guards that normalise whatever the model sent back.

import { MATH_TOPICS, type MathTopic } from './types';

// One line per topic: what it covers, then its classic slips.
export const TOPIC_HINTS: Record<MathTopic, string> = {
  algebra_manipulation:
    'rearranging, expanding and factorising expressions and equations; classic slips: doing an operation to only one side of the equals sign, and dropping or misreading brackets',
  sign_errors:
    'minus signs through brackets and across the equals sign; classic slips: flipping only some signs when expanding -(a+b), and losing a negative when moving a term over',
  fractions:
    'adding, subtracting, multiplying and simplifying fractions; classic slips: adding numerators and denominators straight across, and cancelling terms that are not factors of the whole top and bottom',
  indices:
    'power laws for multiplying, dividing and raising powers; classic slips: adding indices when the bases differ, and reading (x^a)^b as x^(a+b)',
  logarithms:
    'log laws, changing base and solving log equations; classic slips: treating log(a+b) as log a + log b, and dropping a coefficient that sits in front of a log',
  differentiation_chain_rule:
    'differentiating composite functions; the classic slip is forgetting to multiply by the derivative of the inner function',
  differentiation_product_quotient:
    'product and quotient rule; classic slips: differentiating each factor separately instead of using the rule, and swapping the two terms on the top of the quotient rule',
  integration_by_parts:
    'integrating products with the uv formula; classic slips: choosing u and dv the wrong way round, and sign slips when the formula is applied twice',
  integration_substitution:
    'integration by substitution; classic slips: forgetting to substitute for dx, and not converting the limits to the new variable',
  trigonometric_identities:
    'simplifying and proving with identities; classic slips: treating (sin x)^2 like sin(x^2), and claiming sin(A+B) = sin A + sin B',
  vectors:
    'vector arithmetic, magnitude, unit vectors and the dot product; classic slips: forgetting the square root in a magnitude, and mixing components of different vectors',
  probability:
    'tree diagrams, combined events and conditional probability; classic slips: multiplying branch probabilities that do not sum to 1, and swapping P(A given B) with P(B given A)',
  statistics:
    'mean, median, mode, variance, standard deviation and the normal distribution; classic slips: dividing by the wrong count, and forgetting the square root when going from variance to standard deviation',
  complex_numbers:
    'arithmetic with i, conjugates, moduli and Argand diagrams; classic slips: reading i^2 as 1, and conjugating only part of a fraction',
  sequences_series:
    'arithmetic and geometric progressions and sigma notation; classic slips: mixing up the arithmetic and geometric formulas, and using the wrong term count',
  other:
    'anything that fits none of the topics above, or a slip that mixes several of them; use it sparingly',
};

export function isMathTopic(x: string): x is MathTopic {
  return (MATH_TOPICS as readonly string[]).includes(x);
}

// Model output can arrive as 'Chain Rule' or 'chain  rule'; taxonomy ids are
// lowercase with underscores, and anything unknown lands on 'other'.
export function normalizeTopic(raw: string): MathTopic {
  const key = raw.trim().toLowerCase().replaceAll(/\s+/g, '_');
  return isMathTopic(key) ? key : 'other';
}
