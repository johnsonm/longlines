// Band table. Source: HamAlert config_clean.js, config.bands. All values in kHz.
//
// 3cm_qo100 and 3cm overlap; 3cm_qo100 is listed first so QO-100 frequencies
// get the more specific tag. bandForFrequency relies on this ordering.
export const BANDS: ReadonlyArray<{ from: number; to: number; band: string }> = [
  { from: 135, to: 138, band: "2200m" },
  { from: 472, to: 479, band: "600m" },
  { from: 1800, to: 2000, band: "160m" },
  { from: 3500, to: 4000, band: "80m" },
  { from: 5000, to: 5500, band: "60m" },
  { from: 7000, to: 7300, band: "40m" },
  { from: 10000, to: 10200, band: "30m" },
  { from: 14000, to: 14500, band: "20m" },
  { from: 18000, to: 18200, band: "17m" },
  { from: 21000, to: 21500, band: "15m" },
  { from: 24800, to: 25000, band: "12m" },
  { from: 26000, to: 27999, band: "11m" },
  { from: 28000, to: 30000, band: "10m" },
  { from: 40000, to: 41000, band: "8m" },
  { from: 50000, to: 54000, band: "6m" },
  { from: 70000, to: 71000, band: "4m" },
  { from: 144000, to: 148000, band: "2m" },
  { from: 219000, to: 225000, band: "1.25m" },
  { from: 430000, to: 440000, band: "70cm" },
  { from: 1200000, to: 1400000, band: "23cm" },
  { from: 2300000, to: 2450000, band: "13cm" },
  { from: 3300000, to: 3500000, band: "9cm" },
  { from: 5400000, to: 5900000, band: "6cm" },
  { from: 10489550, to: 10490000, band: "3cm_qo100" },
  { from: 10000000, to: 10500000, band: "3cm" },
];

/** Band name for a frequency in kHz, or null when it falls outside every known band. */
export function bandForFrequency(freqKhz: number): string | null {
  for (const b of BANDS) {
    if (freqKhz >= b.from && freqKhz <= b.to) {
      return b.band;
    }
  }
  return null;
}
