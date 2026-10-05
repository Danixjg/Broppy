import type { Bank } from "../types.js";
import { CARD } from "./card.js";
import { COMPANY } from "./company.js";
import { DATA } from "./data-warehouse.js";
import { ENG } from "./eng.js";
import { PEOPLE } from "./hr.js";
import { INTERN } from "./intern.js";
import { KYC } from "./kyc.js";
import { LEGAL } from "./legal.js";
import { MOB } from "./mob.js";
import { PLAT } from "./plat.js";
import { VEND } from "./vend.js";

/** The areas of the demo dataset, in the order they are generated. */
export const BANKS: readonly Bank[] = [PLAT, MOB, DATA, KYC, CARD, VEND, ENG, LEGAL, PEOPLE, COMPANY, INTERN];
