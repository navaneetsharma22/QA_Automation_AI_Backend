const raw = `[01:19 pm] Tiffany Norris: I'm freaking out because I need to know if I can cancel my ticket online and it's not working. I'm trying to figure out how to do it and none of the steps I'm following are making sense.
[01:21 pm] System: ROBERT has accepted this query
[01:23 pm] ROBERT: Hello Tiffany! Welcome to Corendon Airlines. My name is Robert. I'm here to assist you today.
[01:24 pm] Tiffany Norris: I'm trying to cancel my flight XC240 from Berlin to Madrid but the online system isn't cooperating. Can you walk me through it step by step?
[01:26 pm] ROBERT: Tiffany, I understand you are facing issue while cancelling your ticket. May I know where you made this booking? Was it directly through our official website or through a third-party travel agency or app?
[01:27 pm] Tiffany Norris: Um, I booked it online, I think? I don't really remember how I booked it, I was on your website...
[01:30 pm] ROBERT: Just to confirm, Do you made this booking from Corendon Airlines?
[01:31 pm] Tiffany Norris: Yeah, I know I booked it with you. I even have the email confirmation somewhere.
`;

let cleaned = raw;
cleaned = cleaned.replace(/^\[\d{2}:\d{2}\s+[ap]m\]\s*/gm, '');
cleaned = cleaned.replace(/thank you for contacting.*?(\.|\!|\?)\s?/gi, '');
cleaned = cleaned.replace(/welcome to.*?(\.|\!|\?)\s?/gi, '');
cleaned = cleaned.replace(/my name is [A-Za-z\s]+.*?(\.|\!|\?)\s?/gi, '');
cleaned = cleaned.replace(/^.*has accepted this query.*\s*/gm, '');

console.log(cleaned);
