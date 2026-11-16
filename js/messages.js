// What the cat mascot says. Add your own lines; one is picked at random.
// Lines shown in the top bar must stay at most 60 characters, so they fit on two lines
// and the bar keeps the same height (checked by `npm test`).

// While filling in, before an issue is chosen.
export const START = [
  'Goed van je dat je opkomt voor je rechten!',
  'Toegankelijk OV is een recht, geen gunst.',
  'Jij bent niet het probleem. Dit hoort gewoon te werken.',
  'Even diep ademhalen. Dit is zo geregeld.',
  'Elke melding maakt het probleem zichtbaar. Zet hem op!',
  'Miauw! Ik help je even. Paar tikjes en klaar.',
];

// Once an issue is chosen (by issue id from config.js).
export const ISSUE = {
  seatbelt: ['Veilig vastzitten is wel het minste wat je mag verwachten.'],
  ramp: ['Zonder werkende oprijplaat geen bus. Goed dat je dit meldt.'],
  driver: ['Zo hoort niemand behandeld te worden. Laat het ze weten.', 'Die chauffeur had een slechte dag. Dat is niet jouw schuld.'],
  other: ['Schrijf het gewoon op zoals het was. Ik luister.'],
};

// After "Nu versturen".
export const DONE_SENT = [
  'Dit had niet mogen gebeuren. Goed dat je het meldt.',
  'Gemeld! De rest van je dag is van jou.',
  'Klaar. Nu weer even aan iets leukers denken.',
  'Je hebt het gedaan. Trots op je!',
];

// After "Bewaar, later versturen".
export const DONE_DRAFT = [
  'Opgeslagen! Rond het af wanneer het jou uitkomt.',
  'Staat erin. Nu even niks meer mee doen.',
  'Bewaard. Eerst iets leuks, de rest komt later.',
];

export const pick = (list) => list[Math.floor(Math.random() * list.length)];

// Logboek tab.
export const LOG = [
  'Hier staat alles wat je gemeld hebt. Elke melding telt!',
  'Kijk eens wat je allemaal hebt aangekaart. Respect!',
  'Al deze meldingen maken het probleem zichtbaar.',
];
export const LOG_EMPTY = ['Nog niks gemeld. Hopelijk blijft dat zo!'];
export const LOG_DRAFTS = ['Er staat nog iets klaar om af te maken. Geen haast.'];

// Instellingen tab.
export const SETTINGS = [
  'Hier regel je alles. Je gegevens blijven bij jou.',
  'Alles op een rijtje? Dan kun je zo weer melden.',
];
export const SETTINGS_NO_EMAIL = ['Vul je e-mailadres in voor de bevestigingsmail.'];

// When you pick up a saved complaint again.
export const RESUME = ['Welkom terug! Even afmaken en dan ben je ervan af.'];

// In the header on the screen after sending or saving.
export const DONE_HEADER = ['Goed gedaan!'];
