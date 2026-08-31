/**
 * GST place of supply.
 *
 * The rate is the same everywhere; what changes is how it is split. A sale
 * inside the supplier's own state is CGST + SGST, half each. A sale to another
 * state is IGST, the whole amount in one line. The customer pays exactly the
 * same either way, which is precisely why it gets missed — nothing on the page
 * looks wrong, and the error only surfaces at return time when every invoice
 * has to be reissued.
 *
 * State codes are the official GST ones, and they are what a GSTIN starts with:
 * ours is 29BSMPK7696H1ZT, so ServerPe App Solutions is registered in Karnataka
 * (29). Keeping the codes here means an invoice can show the pair a filing
 * actually needs.
 */

export interface IndianState {
  code: string;
  name: string;
  union: boolean;
}

/** Every state and union territory, in the order a dropdown should show them. */
export const INDIAN_STATES: readonly IndianState[] = [
  { code: '37', name: 'Andhra Pradesh', union: false },
  { code: '12', name: 'Arunachal Pradesh', union: false },
  { code: '18', name: 'Assam', union: false },
  { code: '10', name: 'Bihar', union: false },
  { code: '22', name: 'Chhattisgarh', union: false },
  { code: '30', name: 'Goa', union: false },
  { code: '24', name: 'Gujarat', union: false },
  { code: '06', name: 'Haryana', union: false },
  { code: '02', name: 'Himachal Pradesh', union: false },
  { code: '20', name: 'Jharkhand', union: false },
  { code: '29', name: 'Karnataka', union: false },
  { code: '32', name: 'Kerala', union: false },
  { code: '23', name: 'Madhya Pradesh', union: false },
  { code: '27', name: 'Maharashtra', union: false },
  { code: '14', name: 'Manipur', union: false },
  { code: '17', name: 'Meghalaya', union: false },
  { code: '15', name: 'Mizoram', union: false },
  { code: '13', name: 'Nagaland', union: false },
  { code: '21', name: 'Odisha', union: false },
  { code: '03', name: 'Punjab', union: false },
  { code: '08', name: 'Rajasthan', union: false },
  { code: '11', name: 'Sikkim', union: false },
  { code: '33', name: 'Tamil Nadu', union: false },
  { code: '36', name: 'Telangana', union: false },
  { code: '16', name: 'Tripura', union: false },
  { code: '09', name: 'Uttar Pradesh', union: false },
  { code: '05', name: 'Uttarakhand', union: false },
  { code: '19', name: 'West Bengal', union: false },

  { code: '35', name: 'Andaman & Nicobar Islands', union: true },
  { code: '04', name: 'Chandigarh', union: true },
  { code: '26', name: 'Dadra & Nagar Haveli and Daman & Diu', union: true },
  { code: '07', name: 'Delhi', union: true },
  { code: '38', name: 'Ladakh', union: true },
  { code: '01', name: 'Jammu & Kashmir', union: true },
  { code: '31', name: 'Lakshadweep', union: true },
  { code: '34', name: 'Puducherry', union: true },
];

export function stateByCode(code: string): IndianState | undefined {
  return INDIAN_STATES.find((s) => s.code === code);
}

export function stateByName(name: string): IndianState | undefined {
  const wanted = name.trim().toLowerCase();
  return INDIAN_STATES.find((s) => s.name.toLowerCase() === wanted);
}

/** The supplier's state code, read from the GSTIN's first two digits. */
export function stateCodeFromGstin(gstin: string | null | undefined): string | null {
  if (!gstin || gstin.length < 2) return null;
  const code = gstin.slice(0, 2);
  return stateByCode(code) ? code : null;
}

export interface GstSplit {
  /** true when supplier and customer are in the same state. */
  intraState: boolean;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalTaxPaise: number;
}

/**
 * Splits an already-computed tax amount into its GST components.
 *
 * Takes the tax, not the price, because whether GST is inclusive or exclusive
 * is a separate decision made elsewhere — this function only answers "which
 * boxes does this tax go in".
 *
 * The odd paisa goes to CGST when the tax does not halve exactly. Some
 * convention is required, this one is conventional, and being consistent
 * matters more than which half is rounded up.
 */
export function splitPlaceOfSupply(
  taxPaise: number,
  supplierStateCode: string | null,
  customerStateCode: string | null,
): GstSplit {
  // Unknown customer state is treated as inter-state. It is the safer default:
  // IGST wrongly charged is corrected with a credit note, whereas a missing
  // SGST liability is a shortfall to the state.
  const intraState = Boolean(
    supplierStateCode && customerStateCode && supplierStateCode === customerStateCode,
  );

  if (!intraState) {
    return { intraState: false, cgstPaise: 0, sgstPaise: 0, igstPaise: taxPaise, totalTaxPaise: taxPaise };
  }

  const sgst = Math.floor(taxPaise / 2);
  const cgst = taxPaise - sgst;
  return { intraState: true, cgstPaise: cgst, sgstPaise: sgst, igstPaise: 0, totalTaxPaise: taxPaise };
}
