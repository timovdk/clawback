// Everything that depends on U-OV's Zendesk form lives here.
// Field IDs come from the saved form page ("Toegankelijkheid"). If U-OV changes the form,
// re-save the page and update these values; tools/prefill-test.html helps to verify.

export const FORM = {
  url: 'https://klantenservice.u-ov.nl/hc/nl/requests/new',
  ticketFormId: '31913821575069', // Toegankelijkheid
  fields: {
    email: 'anonymous_requester_email',
    subject: 'subject',
    description: 'description', // must be HTML: one <p> per line
    subcategory: '31970454147613',
    date: '31967369101853', // Datum reiservaring, YYYY-MM-DD
    type: '31914234696349',
    reply: '31915063055389', // 'ja' | 'nee'
  },
  typeValue: 'klacht',
};

// Subcategory tags available on the form.
const SUB = {
  boarding: 'instappen_en_haltes',
  noHelp: 'gebrek_aan_hulp_bij_instappen',
  unsafe: 'onveilig_of_niet_prettig_gevoel_tijdens_de_reis_',
  other: 'overig',
};

// Issue buttons. An issue either has its own template, or `sub` with sub-buttons.
// `text` is the starting complaint text; it stays editable in the app.
// `modes`: which vehicles the issue applies to ('bus', 'tram'); leave out for all.
// `detail`: an extra box whose answer is added to the complaint as its own block.
const DRIVER_DETAIL = {
  label: 'Wat zei of deed de chauffeur?',
  placeholder: 'Letterlijke woorden als je die nog weet, of wat er gebeurde',
  heading: 'Wat de chauffeur zei of deed:',
};

export const ISSUES = [
  {
    id: 'seatbelt',
    modes: ['bus'],
    label: 'Gordel',
    hint: 'gordel / vastzetten rolstoel',
    subcategory: SUB.unsafe,
    subject: 'Gordel rolstoelplek defect',
    text: 'De gordel op de rolstoelplek was defect, waardoor ik tijdens de rit niet veilig vastgezet kon worden. Ik verzoek u dit voertuig te laten repareren.',
  },
  {
    id: 'ramp',
    modes: ['bus'],
    label: 'Oprijplaat',
    hint: 'kapot of niet uitgeklapt',
    subcategory: SUB.boarding,
    subject: 'Oprijplaat defect',
    text: 'De oprijplaat van de bus werkte niet, waardoor ik niet veilig kon in- of uitstappen. Ik verzoek u dit voertuig te laten repareren.',
  },
  {
    id: 'driver',
    modes: ['bus'],
    label: 'Chauffeur',
    hint: 'kies hieronder wat er gebeurde',
    sub: [
      {
        id: 'no-help',
        label: 'Niet geholpen',
        subcategory: SUB.noHelp,
        subject: 'Chauffeur hielp niet bij in- of uitstappen',
        text: 'De chauffeur heeft mij niet geholpen bij het in- of uitstappen, terwijl ik daar wel hulp bij nodig had.',
      },
      {
        id: 'ableist',
        label: 'Neerbuigend / validistisch',
        subcategory: SUB.unsafe,
        subject: 'Chauffeur behandelde mij neerbuigend vanwege mijn beperking',
        text: 'De chauffeur behandelde mij neerbuigend vanwege mijn beperking.',
        detail: DRIVER_DETAIL,
      },
      {
        id: 'inappropriate',
        label: 'Ongepaste opmerking',
        subcategory: SUB.unsafe,
        subject: 'Ongepaste opmerking van chauffeur',
        text: 'De chauffeur maakte een ongepaste opmerking.',
        detail: DRIVER_DETAIL,
      },
      {
        id: 'driving',
        label: 'Onveilige rijstijl',
        subcategory: SUB.unsafe,
        subject: 'Onveilige rijstijl chauffeur',
        text: 'De chauffeur reed onveilig: te hard, te scherp door de bochten, en hard remmen en optrekken. Op de rolstoelplek voelde dit erg onveilig.',
      },
      {
        id: 'no-wait',
        label: 'Reed te vroeg weg',
        subcategory: SUB.unsafe,
        subject: 'Chauffeur reed weg voordat ik veilig stond',
        text: 'De chauffeur reed weg voordat ik veilig op de rolstoelplek stond of vastgezet was.',
      },
      {
        id: 'passed',
        label: 'Niet gestopt',
        subcategory: SUB.boarding,
        subject: 'Bus stopte niet bij de halte',
        text: 'De bus stopte niet bij de halte, terwijl ik daar duidelijk zichtbaar stond te wachten.',
      },
    ],
  },
  {
    id: 'other',
    label: 'Anders',
    hint: 'zelf beschrijven',
    subcategory: SUB.other,
    subject: 'Melding toegankelijkheid',
    text: '',
  },
];
