export const SUPABASE_URL = "https://gqocavvhhfwgkzscrjms.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imdxb2NhdnZoaGZ3Z2t6c2Nyam1zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg2MzE2MDMsImV4cCI6MjEwNDIwNzYwM30.x4HxOcAiusptsdflVje61wY8t9IfMOAGsCdUg3pIGaQ";

export const VAPID_PUBLIC_KEY = "BGKcsJH4YH7vV384UCmx_FKD0xGiWTNuMA7skLLUWzIodKXTSFLRleq1K0ttPMnXZfzQO42bQig8nSKTSIw1jts";

export const ADMINS = [
  { email: "aabntlal680@gmail.com", name: "الوليد بن طلال" },
  { email: "almgawell17@gmail.com", name: "لمياء بنت ماجد" },
  { email: "almgawell@gmail.com", name: "ريم بنت الوليد" },
  { email: "almgawell1992@gmail.com", name: "ملاك العتيبي" },
  { email: "almgawell1121@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell1212@gmail.com", name: "اسماء المليكي" },
  { email: "almgawell5@gmail.com", name: "لمياء بنت ماجد" },
  { email: "almgawell4@gmail.com", name: "ريم بنت الوليد" },
  { email: "almgawell3@gmail.com", name: "ملاك العتيبي" },
  { email: "almgawell2@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell1@gmail.com", name: "اسماء المليكي" },
  { email: "almgawell6@gmail.com", name: "لمياء بنت ماجد" },
  { email: "almgawell7@gmail.com", name: "ريم بنت الوليد" },
  { email: "almgawell8@gmail.com", name: "ملاك العتيبي" },
  { email: "almgawell9@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell10@gmail.com", name: "اسماء المليكي" },
  { email: "almgawell0@gmail.com", name: "عبير الدوسري" },
  { email: "almgawell11@gmail.com", name: "اسماء المليكي" },
];

export function isAdminEmail(email) {
  return ADMINS.some((a) => a.email.toLowerCase() === (email || "").toLowerCase());
}
