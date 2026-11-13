/**
 * The CSS breakpoints (DESIGN.md) for the few places script has to know the layout. CSS cannot read a
 * custom property inside `@media`, so the numbers are repeated here: keep the two in step.
 */

/** phone layout: below the 600px breakpoint, where the sidebar is a drawer over the page */
export const PHONE_QUERY = '(max-width: 599.98px)';
