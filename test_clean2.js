const raw = `Donna Weber
it's about the free cancellation, yeah?

02 Jul, 02:46 pm IST
about 2 hours ago
K
KRIS (Agent)
Could you please confirm where you booked your ticket—directly through our website, a third-party platform, or a travel agency?

02 Jul, 02:46 pm IST
about 2 hours ago
D
Donna Weber
I booked it through your website, but I don't know if that changes anything.`;

let cleaned = raw;

  // 1. Remove Date & Time entirely and just keep Speaker Name
  // Note: old regex: /^\d{1,2}\s+[A-Za-z]{3},\s+\d{2}:\d{2}\s+[ap]m\s+IST\r?\n([^\n]+)\r?\n/gm
  cleaned = cleaned.replace(/^\d{1,2}\s+[A-Za-z]{3},\s+\d{2}:\d{2}\s+[ap]m\s+IST\r?\n([^\n]+)\r?\n/gm, '\n$1:\n');
  
  // 1b. Remove [hh:mm am/pm] timestamps if they are already compressed in the UI
  cleaned = cleaned.replace(/^\[\d{2}:\d{2}\s+[ap]m\]\s*/gm, '');
  
  // 2. Remove "X minutes ago"
  cleaned = cleaned.replace(/^\d+\s+(minute|hour)s?\s+ago\s*/gm, '');
  
  // 3. Remove stray single-letter initials on their own line
  cleaned = cleaned.replace(/^[A-Z]\r?\n/gm, '');

console.log(cleaned);
