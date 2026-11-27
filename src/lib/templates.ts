/**
 * Static site templates — Step 11 (P1).
 *
 * Real, complete, single-file HTML templates that the user can apply with
 * ZERO model calls: "Use template" copies the template HTML through the
 * existing POST /api/tools/file-write path (which runs the deployHtmlFile
 * PWA path for projects/*.html) and shows the local preview. No provider
 * (Gemini / Groq / OpenRouter) is contacted at any step, and no API key is
 * needed. Templates are bundled here (not fetched) so they also work
 * offline. Every template is self-contained: inline CSS, system font stack
 * (Bengali-friendly), no external CDN, no external images.
 */
import {
  Globe,
  Briefcase,
  ShoppingBag,
  UtensilsCrossed,
  Scissors,
  GraduationCap,
  MoonStar,
  FileText,
  PartyPopper,
  Newspaper,
  Link2,
  Timer,
  type LucideIcon,
} from 'lucide-react';

export interface StaticTemplate {
  id: string;
  title: string;
  kind: string;
  badge: string;
  description: string;
  icon: LucideIcon;
  color: string;
  /** Complete standalone HTML document (inline CSS, no external deps). */
  html: string;
}

export const STATIC_TEMPLATES: StaticTemplate[] = [
  {
    id: 'landing',
    title: 'ব্যবসার ল্যান্ডিং পেজ',
    kind: 'Landing',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'হিরো, সুবিধা, মূল্য ও যোগাযোগ — যেকোনো ছোট ব্যবসার জন্য।',
    icon: Globe,
    color: 'from-indigo-500/20 to-purple-500/20 border-indigo-500/30 text-indigo-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#4f46e5">
<title>সহজ বাজার — মানসম্মত পণ্য, সেরা দামে</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;color:#0f172a;background:#f8fafc;line-height:1.7}
a{text-decoration:none;color:inherit}
.wrap{max-width:1080px;margin:0 auto;padding:0 20px}
header{background:#fff;border-bottom:1px solid #e2e8f0;position:sticky;top:0;z-index:10}
.nav{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;max-width:1080px;margin:0 auto}
.logo{font-size:22px;font-weight:800;color:#4f46e5}
.nav a.btn{background:#4f46e5;color:#fff;padding:10px 20px;border-radius:999px;font-weight:700;font-size:14px}
.hero{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:#fff;padding:72px 0 80px;text-align:center}
.hero h1{font-size:40px;line-height:1.25;margin-bottom:12px}
.hero p{opacity:.9;max-width:560px;margin:0 auto 24px}
.hero .cta{display:inline-block;background:#fff;color:#4f46e5;padding:13px 30px;border-radius:999px;font-weight:800}
.hero .cta2{display:inline-block;border:2px solid #fff;color:#fff;padding:11px 28px;border-radius:999px;font-weight:700;margin-left:10px}
section{padding:64px 0}
h2{text-align:center;font-size:28px;margin-bottom:8px}
.sub{text-align:center;color:#64748b;margin-bottom:36px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:26px}
.card .ic{font-size:30px;margin-bottom:10px}
.card h3{font-size:18px;margin-bottom:6px}
.card p{color:#64748b;font-size:14px}
.price{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px}
.plan{background:#fff;border:2px solid #e2e8f0;border-radius:16px;padding:28px;text-align:center}
.plan.hot{border-color:#4f46e5;box-shadow:0 12px 30px rgba(79,70,229,.15)}
.plan .amt{font-size:36px;font-weight:800;color:#4f46e5}
.plan ul{list-style:none;margin:16px 0;color:#475569;font-size:14px}
.plan li{padding:5px 0}
.plan a{display:inline-block;background:#4f46e5;color:#fff;padding:11px 26px;border-radius:999px;font-weight:700}
.cta-band{background:#0f172a;color:#fff;text-align:center;border-radius:20px;padding:48px 24px}
.cta-band a{display:inline-block;background:#4f46e5;color:#fff;padding:13px 30px;border-radius:999px;font-weight:800;margin-top:18px}
footer{background:#0f172a;color:#94a3b8;text-align:center;padding:28px;font-size:14px}
@media(max-width:640px){.hero h1{font-size:29px}}
</style>
</head>
<body>
<header><div class="nav"><div class="logo">সহজ বাজার</div><a class="btn" href="#contact">যোগাযোগ করুন</a></div></header>
<div class="hero"><div class="wrap">
<h1>মানসম্মত পণ্য, সেরা দামে —<br>আপনার দরজায় পৌঁছে যাবে</h1>
<p>রংপুরসহ সারা দেশে হোম ডেলিভারি। ক্যাশ অন ডেলিভারি সুবিধা, সহজ রিটার্ন আর বন্ধুত্বপূর্ণ সেবা।</p>
<a class="cta" href="#plans">অর্ডার করুন</a><a class="cta2" href="#features">আরও জানুন</a>
</div></div>
<section id="features"><div class="wrap">
<h2>কেন আমরাই সেরা?</h2><p class="sub">গ্রাহকের আস্থাই আমাদের সবচেয়ে বড় সম্পদ</p>
<div class="cards">
<div class="card"><div class="ic">🚚</div><h3>দ্রুত ডেলিভারি</h3><p>ঢাকায় ২৪ ঘণ্টা, ঢাকার বাইরে ৪৮–৭২ ঘণ্টায় ডেলিভারি।</p></div>
<div class="card"><div class="ic">💰</div><h3>ক্যাশ অন ডেলিভারি</h3><p>পণ্য হাতে পেয়ে তারপর পেমেন্ট — কোনো আগাম ঝুঁকি নেই।</p></div>
<div class="card"><div class="ic">🔄</div><h3>সহজ রিটার্ন</h3><p>৭ দিনের মধ্যে যেকোনো ত্রুটিপূর্ণ পণ্য বদলে নেওয়া যায়।</p></div>
<div class="card"><div class="ic">📞</div><h3>সাপোর্ট</h3><p>সকাল ৯টা থেকে রাত ৯টা — ফোন, মেসেঞ্জার ও হোয়াটসঅ্যাপে।</p></div>
</div></div></section>
<section id="plans" style="background:#fff"><div class="wrap">
<h2>জনপ্রিয় প্যাকেজ</h2><p class="sub">আপনার প্রয়োজন অনুযায়ী বেছে নিন</p>
<div class="price">
<div class="plan"><h3>স্টার্টার</h3><div class="amt">৳৪৯৯</div><ul><li>৫টি পণ্য</li><li>ঢাকায় ফ্রি ডেলিভারি</li><li>ইমেইল সাপোর্ট</li></ul><a href="#contact">বেছে নিন</a></div>
<div class="plan hot"><h3>জনপ্রিয় ⭐</h3><div class="amt">৳৯৯৯</div><ul><li>১৫টি পণ্য</li><li>সারা দেশে ফ্রি ডেলিভারি</li><li>অগ্রাধিকার সাপোর্ট</li></ul><a href="#contact">বেছে নিন</a></div>
<div class="plan"><h3>বিজনেস</h3><div class="amt">৳১,৯৯৯</div><ul><li>আনলিমিটেড পণ্য</li><li>পাইকারি দাম</li><li>ডেডিকেটেড ম্যানেজার</li></ul><a href="#contact">বেছে নিন</a></div>
</div></div></section>
<section id="contact"><div class="wrap"><div class="cta-band">
<h2 style="color:#fff">আজই অর্ডার করুন</h2>
<p style="opacity:.85">ফোন: ০১৭০০-০০০০০০ • হোয়াটসঅ্যাপেও অর্ডার করা যায়</p>
<a href="tel:01700000000">এখনই কল করুন</a>
</div></div></section>
<footer>© ২০২৬ সহজ বাজার • রংপুর, বাংলাদেশ</footer>
</body>
</html>`,
  },
  {
    id: 'portfolio',
    title: 'ক্রিয়েটিভ পোর্টফোলিও',
    kind: 'Portfolio',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'কাজের নমুনা, দক্ষতা ও যোগাযোগ — ফ্রিল্যান্সার ও ডিজাইনারদের জন্য।',
    icon: Briefcase,
    color: 'from-fuchsia-500/20 to-pink-500/20 border-fuchsia-500/30 text-fuchsia-300',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0f172a">
<title>Mehedi Hasan — Creative Designer &amp; Developer</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;line-height:1.7}
.wrap{max-width:1000px;margin:0 auto;padding:0 20px}
header{padding:28px 0;display:flex;justify-content:space-between;align-items:center}
.logo{font-weight:800;font-size:20px;color:#fff}
.logo span{color:#a78bfa}
nav a{color:#94a3b8;margin-left:22px;font-size:14px;text-decoration:none}
nav a:hover{color:#fff}
.hero{padding:70px 0 60px;text-align:center}
.hero .avatar{width:110px;height:110px;border-radius:50%;background:linear-gradient(135deg,#7c3aed,#ec4899);display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800;color:#fff;margin:0 auto 20px}
.hero h1{font-size:38px;color:#fff}
.hero h1 span{color:#a78bfa}
.hero p{color:#94a3b8;max-width:540px;margin:12px auto 24px}
.btn{display:inline-block;background:#7c3aed;color:#fff;padding:12px 28px;border-radius:999px;font-weight:700;text-decoration:none}
.btn.ghost{background:transparent;border:1px solid #475569;color:#e2e8f0;margin-left:10px}
section{padding:48px 0}
h2{color:#fff;font-size:26px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}
.card{background:#1e293b;border:1px solid #334155;border-radius:16px;overflow:hidden}
.card .thumb{height:150px;display:flex;align-items:center;justify-content:center;font-size:48px;background:linear-gradient(135deg,#312e81,#4c1d95)}
.card .body{padding:20px}
.card h3{color:#fff;font-size:17px;margin-bottom:6px}
.card p{color:#94a3b8;font-size:14px}
.tag{display:inline-block;background:#7c3aed33;color:#c4b5fd;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;margin-top:12px}
.skill{margin-bottom:16px}
.skill .row{display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px}
.bar{height:8px;background:#334155;border-radius:99px;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#7c3aed,#ec4899);border-radius:99px}
.testi{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:24px;color:#cbd5e1;font-style:italic}
.contact{text-align:center;background:linear-gradient(135deg,#7c3aed,#db2777);border-radius:20px;padding:44px 24px}
.contact h2{color:#fff}
.contact a{display:inline-block;background:#fff;color:#7c3aed;padding:12px 28px;border-radius:999px;font-weight:800;text-decoration:none;margin-top:14px}
footer{text-align:center;color:#64748b;padding:28px;font-size:13px}
@media(max-width:640px){.hero h1{font-size:28px}nav a{margin-left:12px}}
</style>
</head>
<body>
<div class="wrap">
<header><div class="logo">Mehedi<span>.</span></div><nav><a href="#work">Work</a><a href="#skills">Skills</a><a href="#contact">Contact</a></nav></header>
<div class="hero">
<div class="avatar">MH</div>
<h1>Hi, I'm Mehedi Hasan —<br><span>Designer &amp; Developer</span></h1>
<p>I build clean, fast websites and brands for small businesses in Bangladesh — from landing pages to full online shops.</p>
<a class="btn" href="#work">See my work</a><a class="btn ghost" href="#contact">Hire me</a>
</div>
<section id="work"><h2>Selected Work</h2><div class="grid">
<div class="card"><div class="thumb">🛍️</div><div class="body"><h3>Munsi Store — Online Shop</h3><p>Full e-commerce site with cart, bKash payment and order tracking.</p><span class="tag">E-Commerce</span></div></div>
<div class="card"><div class="thumb">🎨</div><div class="body"><h3>Brand Identity — Crochet Studio</h3><p>Logo, packaging and Instagram kit for a handmade crochet exporter.</p><span class="tag">Branding</span></div></div>
<div class="card"><div class="thumb">📱</div><div class="body"><h3>Task Manager PWA</h3><p>Offline-first notes &amp; tasks app, installable on any phone.</p><span class="tag">PWA</span></div></div>
</div></section>
<section id="skills"><h2>Skills</h2>
<div class="skill"><div class="row"><span>HTML / CSS / JavaScript</span><span>95%</span></div><div class="bar"><i style="width:95%"></i></div></div>
<div class="skill"><div class="row"><span>React &amp; PWA</span><span>85%</span></div><div class="bar"><i style="width:85%"></i></div></div>
<div class="skill"><div class="row"><span>UI / UX Design</span><span>88%</span></div><div class="bar"><i style="width:88%"></i></div></div>
<div class="skill"><div class="row"><span>Digital Marketing</span><span>80%</span></div><div class="bar"><i style="width:80%"></i></div></div>
</section>
<section><h2>What clients say</h2><div class="testi">"Mehedi delivered our shop website in two days — sales doubled in the first month. Highly recommended." — Rahim Uddin, Rangpur</div></section>
<section id="contact"><div class="contact"><h2>Let's build something great</h2><p>Available for freelance projects — reply within 24 hours.</p><a href="mailto:hello@example.com">hello@example.com</a></div></section>
</div>
<footer>© 2026 Mehedi Hasan • Rangpur, Bangladesh</footer>
</body>
</html>`,
  },
  {
    id: 'shop',
    title: 'দোকান / ই-কমার্স শপ',
    kind: 'Shop',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'পণ্যের তালিকা, ফিল্টার ও কার্ট — ছোট দোকানের অনলাইন শপ।',
    icon: ShoppingBag,
    color: 'from-emerald-500/20 to-teal-500/20 border-emerald-500/30 text-emerald-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#059669">
<title>মুনসি স্টোর — অনলাইন শপ</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:#f0fdf4;color:#0f172a;line-height:1.6}
header{background:#065f46;color:#fff;position:sticky;top:0;z-index:10}
.nav{max-width:1080px;margin:0 auto;padding:14px 20px;display:flex;justify-content:space-between;align-items:center}
.logo{font-size:22px;font-weight:800}
.cart-btn{background:#fff;color:#065f46;border:0;padding:9px 18px;border-radius:999px;font-weight:800;cursor:pointer;font-size:14px}
.hero{background:linear-gradient(135deg,#059669,#065f46);color:#fff;text-align:center;padding:52px 20px}
.hero h1{font-size:34px;margin-bottom:8px}
.hero p{opacity:.9}
.wrap{max-width:1080px;margin:0 auto;padding:28px 20px}
.filters{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:22px}
.filters button{border:1px solid #a7f3d0;background:#fff;color:#065f46;padding:8px 16px;border-radius:999px;cursor:pointer;font-weight:700;font-size:13px}
.filters button.on{background:#059669;color:#fff}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:16px}
.card{background:#fff;border:1px solid #d1fae5;border-radius:16px;padding:18px;text-align:center}
.card .pic{font-size:52px;margin-bottom:8px}
.card h3{font-size:16px}
.card .pr{color:#059669;font-weight:800;font-size:19px;margin:6px 0}
.card .old{color:#94a3b8;text-decoration:line-through;font-size:13px;margin-left:6px}
.card button{background:#059669;color:#fff;border:0;padding:10px 20px;border-radius:999px;font-weight:700;cursor:pointer;width:100%}
.card button:hover{background:#047857}
#cartBox{background:#fff;border:2px solid #059669;border-radius:16px;padding:20px;margin-top:28px}
#cartBox h2{font-size:19px;margin-bottom:10px}
#cartItems{color:#475569;font-size:14px}
#cartItems div{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #d1fae5}
.total{font-weight:800;font-size:18px;margin-top:12px;text-align:right}
.order{background:#059669;color:#fff;border:0;padding:12px 26px;border-radius:999px;font-weight:800;cursor:pointer;margin-top:12px;width:100%}
.note{text-align:center;color:#64748b;font-size:13px;margin-top:22px}
footer{background:#064e3b;color:#a7f3d0;text-align:center;padding:22px;font-size:13px}
</style>
</head>
<body>
<header><div class="nav"><div class="logo">🛒 মুনসি স্টোর</div><button class="cart-btn" onclick="document.getElementById('cartBox').scrollIntoView({behavior:'smooth'})">🛒 কার্ট (<span id="cartCount">0</span>)</button></div></header>
<div class="hero"><h1>প্রয়োজনীয় সব পণ্য এক জায়গায়</h1><p>ক্যাশ অন ডেলিভারি • সারা দেশে ডেলিভারি • সহজ রিটার্ন</p></div>
<div class="wrap">
<div class="filters">
<button class="on" onclick="filterCat('all',this)">সবগুলো</button>
<button onclick="filterCat('grooming',this)">গ্রুমিং</button>
<button onclick="filterCat('home',this)">হোম</button>
<button onclick="filterCat('fashion',this)">ফ্যাশন</button>
</div>
<div class="grid" id="grid"></div>
<div id="cartBox"><h2>🛒 আপনার কার্ট</h2><div id="cartItems">কার্ট এখনো খালি — পছন্দের পণ্য যোগ করুন।</div><div class="total" id="cartTotal"></div><button class="order" onclick="orderNow()">হোয়াটসঅ্যাপে অর্ডার করুন</button></div>
<p class="note">ডেলিভারি চার্জ: ঢাকায় ৳৬০, ঢাকার বাইরে ৳১২০ • ৳১,০০০+ অর্ডারে ফ্রি ডেলিভারি</p>
</div>
<footer>© ২০২৬ মুনসি স্টোর • রংপুর • ফোন: ০১৭০০-০০০০০০</footer>
<script>
var products=[
{name:'জিলেট গার্ড রেজার (১২ পিস)',price:240,old:280,cat:'grooming',pic:'🪒'},
{name:'লর্ড ডিসপোজেবল রেজার',price:40,old:50,cat:'grooming',pic:'✂️'},
{name:'হ্যান্ডমেড ক্রোশে ব্যাগ',price:850,old:1100,cat:'fashion',pic:'👜'},
{name:'গ্র্যানি স্কয়ার কুশন কভার',price:650,old:800,cat:'home',pic:'🧶'},
{name:'সানফ্লাওয়ার টোট ব্যাগ',price:950,old:1200,cat:'fashion',pic:'🌻'},
{name:'বাঁশের টুথব্রাশ (৪ পিস)',price:180,old:240,cat:'grooming',pic:'🪥'},
{name:'হ্যান্ডমেড টেবিল রানার',price:550,old:700,cat:'home',pic:'🏠'},
{name:'ক্রোশে ভেস্ট',price:1250,old:1500,cat:'fashion',pic:'🧥'}
];
var cart={};
function render(list){
var g=document.getElementById('grid');g.innerHTML='';
list.forEach(function(p,i){
var d=document.createElement('div');d.className='card';
d.innerHTML='<div class="pic">'+p.pic+'</div><h3>'+p.name+'</h3><div class="pr">৳'+p.price+'<span class="old">৳'+p.old+'</span></div><button onclick="addToCart('+products.indexOf(p)+')">কার্টে যোগ করুন</button>';
g.appendChild(d);
});
}
function filterCat(c,btn){
document.querySelectorAll('.filters button').forEach(function(b){b.classList.remove('on')});
btn.classList.add('on');
render(c==='all'?products:products.filter(function(p){return p.cat===c}));
}
function addToCart(i){
var p=products[i];cart[p.name]=cart[p.name]||{p:p,q:0};cart[p.name].q++;
renderCart();
}
function renderCart(){
var items=document.getElementById('cartItems');var total=0;var count=0;var html='';
Object.keys(cart).forEach(function(k){
var it=cart[k];total+=it.p.price*it.q;count+=it.q;
html+='<div><span>'+it.p.name+' × '+it.q+'</span><span>৳'+(it.p.price*it.q)+'</span></div>';
});
document.getElementById('cartCount').textContent=count;
if(!html){items.textContent='কার্ট এখনো খালি — পছন্দের পণ্য যোগ করুন।';document.getElementById('cartTotal').textContent='';return;}
items.innerHTML=html;
document.getElementById('cartTotal').textContent='মোট: ৳'+total;
}
function orderNow(){
var total=0;var lines=[];
Object.keys(cart).forEach(function(k){var it=cart[k];total+=it.p.price*it.q;lines.push(it.p.name+' × '+it.q);});
if(!lines.length){alert('প্রথমে কার্টে পণ্য যোগ করুন।');return;}
var msg=encodeURIComponent('আসসালামু আলাইকুম, আমি অর্ডার করতে চাই:%0A'+lines.join('%0A')+'%0Aমোট: ৳'+total);
window.open('https://wa.me/8801700000000?text='+msg,'_blank');
}
render(products);
</script>
</body>
</html>`,
  },
  {
    id: 'restaurant',
    title: 'রেস্তোরাঁ / খাবারের মেনু',
    kind: 'Restaurant',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'বাংলা মেনু, ক্যাটাগরি ফিল্টার ও অর্ডার — রেস্তোরাঁর জন্য।',
    icon: UtensilsCrossed,
    color: 'from-amber-500/20 to-orange-500/20 border-amber-500/30 text-amber-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#b45309">
<title>স্বাদ ঘর — রেস্তোরাঁ ও মেনু</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:#fffbeb;color:#292524;line-height:1.6}
header{background:#7c2d12;color:#fff}
.nav{max-width:1000px;margin:0 auto;padding:16px 20px;display:flex;justify-content:space-between;align-items:center}
.logo{font-size:24px;font-weight:800}
.nav span{font-size:14px;opacity:.9}
.hero{background:linear-gradient(135deg,#b45309,#7c2d12);color:#fff;text-align:center;padding:56px 20px}
.hero h1{font-size:36px;margin-bottom:8px}
.hero p{opacity:.92;max-width:520px;margin:0 auto}
.wrap{max-width:1000px;margin:0 auto;padding:30px 20px}
.filters{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:26px}
.filters button{border:1px solid #fcd34d;background:#fff;color:#92400e;padding:8px 18px;border-radius:999px;cursor:pointer;font-weight:700;font-size:13px}
.filters button.on{background:#b45309;color:#fff;border-color:#b45309}
.menu{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px}
.item{background:#fff;border:1px solid #fde68a;border-radius:16px;padding:20px;display:flex;gap:14px}
.item .pic{font-size:40px}
.item h3{font-size:16px}
.item p{color:#78716c;font-size:13px;margin:3px 0 8px}
.item .pr{color:#b45309;font-weight:800}
.item .pr span{color:#a8a29e;font-weight:400;font-size:12px;margin-left:6px}
.order-box{background:#7c2d12;color:#fff;border-radius:20px;padding:32px 24px;text-align:center;margin-top:36px}
.order-box h2{margin-bottom:8px}
.order-box a{display:inline-block;background:#fbbf24;color:#451a03;padding:12px 30px;border-radius:999px;font-weight:800;text-decoration:none;margin-top:14px}
.info{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-top:28px}
.info div{background:#fff;border:1px solid #fde68a;border-radius:14px;padding:18px;text-align:center;font-size:14px}
footer{background:#292524;color:#d6d3d1;text-align:center;padding:22px;font-size:13px}
</style>
</head>
<body>
<header><div class="nav"><div class="logo">🍛 স্বাদ ঘর</div><span>সকাল ১০টা — রাত ১১টা • রংপুর</span></div></header>
<div class="hero"><h1>ঘরোয়া স্বাদ, রেস্তোরাঁর আয়োজন</h1><p>তাজা উপকরণ, নিজস্ব রেসিপি আর যত্নে রান্না — প্রতিদিনের খাবারে উৎসবের স্বাদ।</p></div>
<div class="wrap">
<div class="filters">
<button class="on" onclick="filterMenu('all',this)">সব</button>
<button onclick="filterMenu('rice',this)">ভাত ও বিরিয়ানি</button>
<button onclick="filterMenu('snack',this)">নাস্তা</button>
<button onclick="filterMenu('drink',this)">পানীয় ও মিষ্টি</button>
</div>
<div class="menu" id="menu"></div>
<div class="order-box"><h2>অর্ডার করতে কল করুন</h2><p>হোম ডেলিভারি: রংপুর শহরে ৳৩০ • ৳৫০০+ অর্ডারে ফ্রি</p><a href="tel:01700000000">📞 ০১৭০০-০০০০০০</a></div>
<div class="info">
<div>📍 <b>ঠিকানা</b><br>জাহাজ কোম্পানি মোড়, রংপুর</div>
<div>🕙 <b>খোলা থাকে</b><br>প্রতিদিন সকাল ১০টা — রাত ১১টা</div>
<div>💳 <b>পেমেন্ট</b><br>ক্যাশ • বিকাশ • নগদ</div>
</div>
</div>
<footer>© ২০২৬ স্বাদ ঘর রেস্তোরাঁ • রংপুর</footer>
<script>
var dishes=[
{name:'চিকেন বিরিয়ানি',desc:'বাসমতি চাল, মুরগি, আলু ও বেরেস্তা — সাথে সালাদ',price:180,tag:'জনপ্রিয়',cat:'rice',pic:'🍗'},
{name:'গরুর মাংসের তেহারি',desc:'সরিষার তেলে রান্না, সাথে বোরহানি',price:220,tag:'',cat:'rice',pic:'🍲'},
{name:'সাদা ভাত + মুরগির ঝোল',desc:'ঘরোয়া স্বাদের প্রতিদিনের সেট মেনু',price:120,tag:'',cat:'rice',pic:'🍚'},
{name:'পরোটা + ডিম ভাজি',desc:'সকালের নাস্তার ক্লাসিক কম্বো',price:60,tag:'',cat:'snack',pic:'🍳'},
{name:'চিকেন সমুচা (২ পিস)',desc:'মুচমুচে সমুচা, সাথে তেঁতুলের চাটনি',price:50,tag:'',cat:'snack',pic:'🥟'},
{name:'ফুচকা (১ প্লেট)',desc:'টক-ঝাল-মিষ্টি পানি, আলু-ছোলার পুর',price:70,tag:'জনপ্রিয়',cat:'snack',pic:'😋'},
{name:'বোরহানি (১ গ্লাস)',desc:'দই, পুদিনা ও মসলার ঠান্ডা পানীয়',price:40,tag:'',cat:'drink',pic:'🥛'},
{name:'মিষ্টি দই',desc:'ঐতিহ্যবাহী বগুড়ার স্টাইলে',price:60,tag:'',cat:'drink',pic:'🍮'},
{name:'লাচ্ছি',desc:'মিষ্টি দইয়ের ঘন লাচ্ছি',price:50,tag:'',cat:'drink',pic:'🥤'}
];
function render(list){
var m=document.getElementById('menu');m.innerHTML='';
list.forEach(function(d){
var el=document.createElement('div');el.className='item';
el.innerHTML='<div class="pic">'+d.pic+'</div><div><h3>'+d.name+'</h3><p>'+d.desc+'</p><div class="pr">৳'+d.price+(d.tag?'<span>⭐ '+d.tag+'</span>':'')+'</div></div>';
m.appendChild(el);
});
}
function filterMenu(c,btn){
document.querySelectorAll('.filters button').forEach(function(b){b.classList.remove('on')});
btn.classList.add('on');
render(c==='all'?dishes:dishes.filter(function(d){return d.cat===c}));
}
render(dishes);
</script>
</body>
</html>`,
  },
  {
    id: 'salon',
    title: 'সেলুন / বিউটি পার্লার',
    kind: 'Salon',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'সার্ভিসের তালিকা, মূল্য ও বুকিং ফর্ম — পার্লারের জন্য।',
    icon: Scissors,
    color: 'from-rose-500/20 to-pink-500/20 border-rose-500/30 text-rose-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#be185d">
<title>রূপসী বিউটি পার্লার — সেলুন ও বিউটি সার্ভিস</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:#fff1f2;color:#1f2937;line-height:1.7}
header{background:#fff;border-bottom:1px solid #fecdd3;position:sticky;top:0;z-index:10}
.nav{max-width:1000px;margin:0 auto;padding:15px 20px;display:flex;justify-content:space-between;align-items:center}
.logo{font-size:22px;font-weight:800;color:#be185d}
.nav a{background:#be185d;color:#fff;padding:9px 20px;border-radius:999px;font-weight:700;text-decoration:none;font-size:14px}
.hero{background:linear-gradient(135deg,#f472b6,#be185d);color:#fff;text-align:center;padding:60px 20px}
.hero h1{font-size:34px;margin-bottom:8px}
.hero p{opacity:.92;max-width:520px;margin:0 auto}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px}
h2{text-align:center;font-size:26px;margin-bottom:6px;color:#881337}
.sub{text-align:center;color:#9f1239;opacity:.75;margin-bottom:28px}
.services{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.svc{background:#fff;border:1px solid #fecdd3;border-radius:16px;padding:22px}
.svc .ic{font-size:32px}
.svc h3{margin:8px 0 4px}
.svc p{color:#6b7280;font-size:14px}
.svc .pr{color:#be185d;font-weight:800;font-size:18px;margin-top:10px}
.svc .pr span{color:#9ca3af;font-weight:400;font-size:12px}
.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-top:8px}
.gallery div{background:linear-gradient(135deg,#fbcfe8,#fda4af);border-radius:14px;height:130px;display:flex;align-items:center;justify-content:center;font-size:44px}
.book{background:#fff;border:2px solid #be185d;border-radius:20px;padding:30px;max-width:560px;margin:40px auto 0}
.book h2{margin-bottom:18px}
.book label{display:block;font-size:14px;font-weight:700;margin:12px 0 4px}
.book input,.book select{width:100%;padding:11px 14px;border:1px solid #fda4af;border-radius:10px;font-size:15px;font-family:inherit}
.book button{width:100%;background:#be185d;color:#fff;border:0;padding:13px;border-radius:999px;font-weight:800;font-size:16px;cursor:pointer;margin-top:20px}
#done{display:none;background:#fdf2f8;border:1px solid #f9a8d4;color:#9d174d;border-radius:12px;padding:14px;margin-top:16px;text-align:center;font-weight:700}
.hours{text-align:center;color:#6b7280;font-size:14px;margin-top:30px}
footer{background:#881337;color:#fbcfe8;text-align:center;padding:22px;font-size:13px}
</style>
</head>
<body>
<header><div class="nav"><div class="logo">💇‍♀️ রূপসী পার্লার</div><a href="#book">বুকিং করুন</a></div></header>
<div class="hero"><h1>আপনার সৌন্দর্য, আমাদের যত্নে</h1><p>অভিজ্ঞ বিউটিশিয়ান, মানসম্মত প্রোডাক্ট আর আরামদায়ক পরিবেশ — প্রতিটি সার্ভিসে নিখুঁত যত্ন।</p></div>
<div class="wrap">
<h2>আমাদের সার্ভিস</h2><p class="sub">সব সার্ভিসে হাইজিন ও কোয়ালিটি নিশ্চিত</p>
<div class="services">
<div class="svc"><div class="ic">💇‍♀️</div><h3>হেয়ার কাট ও স্টাইলিং</h3><p>মহিলাদের সব ধরনের কাট, লেয়ার ও স্টাইল।</p><div class="pr">৳৩০০ <span>থেকে</span></div></div>
<div class="svc"><div class="ic">💅</div><h3>মেনিকিউর ও পেডিকিউর</h3><p>নখের যত্ন, নেইল পলিশ ও আর্ট।</p><div class="pr">৳৪০০ <span>থেকে</span></div></div>
<div class="svc"><div class="ic">✨</div><h3>ফেসিয়াল</h3><p>গোল্ড, হারবাল ও হাইড্রা ফেসিয়াল।</p><div class="pr">৳৮০০ <span>থেকে</span></div></div>
<div class="svc"><div class="ic">👰</div><h3>ব্রাইডাল মেকআপ</h3><p>বিয়ের দিনের সম্পূর্ণ প্যাকেজ — মেকআপ, হেয়ার ও শাড়ি।</p><div class="pr">৳৫,০০০ <span>থেকে</span></div></div>
<div class="svc"><div class="ic">🎨</div><h3>হেয়ার কালার</h3><p>গ্লোবাল কালার, হাইলাইট ও কেরাটিন।</p><div class="pr">৳১,৫০০ <span>থেকে</span></div></div>
<div class="svc"><div class="ic">🧖‍♀️</div><h3>হেয়ার স্পা</h3><p>ডিপ কন্ডিশনিং ও স্ক্যাল্প ট্রিটমেন্ট।</p><div class="pr">৳৭০০ <span>থেকে</span></div></div>
</div>
<h2 style="margin-top:44px">আমাদের কাজের ঝলক</h2>
<div class="gallery"><div>💇‍♀️</div><div>💅</div><div>👰</div><div>✨</div></div>
<div class="book" id="book"><h2>অ্যাপয়েন্টমেন্ট বুক করুন</h2>
<form onsubmit="return bookNow(event)">
<label>আপনার নাম</label><input required placeholder="যেমন: ফাতেমা খাতুন">
<label>ফোন নম্বর</label><input required placeholder="01XXXXXXXXX">
<label>সার্ভিস বেছে নিন</label><select><option>হেয়ার কাট ও স্টাইলিং — ৳৩০০</option><option>মেনিকিউর ও পেডিকিউর — ৳৪০০</option><option>ফেসিয়াল — ৳৮০০</option><option>ব্রাইডাল মেকআপ — ৳৫,০০০</option><option>হেয়ার কালার — ৳১,৫০০</option><option>হেয়ার স্পা — ৳৭০০</option></select>
<label>পছন্দের তারিখ</label><input type="date" required>
<button type="submit">বুকিং নিশ্চিত করুন</button>
</form><div id="done">✅ ধন্যবাদ! আপনার বুকিংটি পেয়েছি — শীঘ্রই ফোনে নিশ্চিত করা হবে।</div></div>
<p class="hours">🕙 খোলা থাকে: প্রতিদিন সকাল ১০টা — রাত ৮টা (শুক্রবার বন্ধ)<br>📍 জাহাজ কোম্পানি মোড়, রংপুর • 📞 ০১৭০০-০০০০০০</p>
</div>
<footer>© ২০২৬ রূপসী বিউটি পার্লার • রংপুর</footer>
<script>
function bookNow(e){e.preventDefault();document.getElementById('done').style.display='block';e.target.reset();return false;}
</script>
</body>
</html>`,
  },
  {
    id: 'tuition',
    title: 'টিউশন / কোচিং সেন্টার',
    kind: 'Tuition',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'বিষয়, ফি ও ভর্তি ফর্ম — কোচিং সেন্টারের জন্য।',
    icon: GraduationCap,
    color: 'from-blue-500/20 to-cyan-500/20 border-blue-500/30 text-blue-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#1d4ed8">
<title>আলো কোচিং সেন্টার — ভর্তি চলছে</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:#eff6ff;color:#0f172a;line-height:1.7}
header{background:#1e3a8a;color:#fff}
.nav{max-width:1000px;margin:0 auto;padding:15px 20px;display:flex;justify-content:space-between;align-items:center}
.logo{font-size:22px;font-weight:800}
.nav a{background:#fbbf24;color:#1e3a8a;padding:9px 20px;border-radius:999px;font-weight:800;text-decoration:none;font-size:14px}
.hero{background:linear-gradient(135deg,#2563eb,#1e3a8a);color:#fff;text-align:center;padding:56px 20px}
.hero h1{font-size:34px;margin-bottom:8px}
.hero p{opacity:.92;max-width:560px;margin:0 auto}
.hero .badge{display:inline-block;background:#fbbf24;color:#1e3a8a;font-weight:800;padding:6px 16px;border-radius:999px;font-size:13px;margin-bottom:14px}
.wrap{max-width:1000px;margin:0 auto;padding:32px 20px}
h2{text-align:center;font-size:26px;margin-bottom:6px}
.sub{text-align:center;color:#475569;margin-bottom:28px}
.courses{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.course{background:#fff;border:1px solid #bfdbfe;border-radius:16px;padding:22px}
.course .cls{display:inline-block;background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:800;padding:3px 12px;border-radius:999px}
.course h3{margin:10px 0 4px}
.course p{color:#64748b;font-size:14px}
.course .fee{color:#1d4ed8;font-weight:800;font-size:18px;margin-top:10px}
table{width:100%;background:#fff;border-collapse:collapse;border-radius:14px;overflow:hidden;font-size:14px}
th{background:#1e3a8a;color:#fff;padding:12px;text-align:left}
td{padding:12px;border-bottom:1px solid #dbeafe}
tr:last-child td{border-bottom:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin:30px 0}
.stats div{background:#fff;border:1px solid #bfdbfe;border-radius:14px;padding:20px;text-align:center}
.stats b{font-size:28px;color:#1d4ed8;display:block}
.teachers{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}
.t{background:#fff;border:1px solid #bfdbfe;border-radius:16px;padding:20px;text-align:center}
.t .av{width:64px;height:64px;border-radius:50%;background:#2563eb;color:#fff;display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:800;margin:0 auto 10px}
.form{background:#fff;border:2px solid #2563eb;border-radius:20px;padding:30px;max-width:560px;margin:40px auto 0}
.form label{display:block;font-size:14px;font-weight:700;margin:12px 0 4px}
.form input,.form select{width:100%;padding:11px 14px;border:1px solid #93c5fd;border-radius:10px;font-size:15px;font-family:inherit}
.form button{width:100%;background:#2563eb;color:#fff;border:0;padding:13px;border-radius:999px;font-weight:800;font-size:16px;cursor:pointer;margin-top:20px}
#done{display:none;background:#eff6ff;border:1px solid #93c5fd;color:#1e40af;border-radius:12px;padding:14px;margin-top:16px;text-align:center;font-weight:700}
footer{background:#1e3a8a;color:#bfdbfe;text-align:center;padding:22px;font-size:13px}
</style>
</head>
<body>
<header><div class="nav"><div class="logo">📚 আলো কোচিং</div><a href="#admit">ভর্তি হোন</a></div></header>
<div class="hero"><span class="badge">🎓 ২০২৬ শিক্ষাবর্ষে ভর্তি চলছে</span><h1>ভালো ফলাফলের নিশ্চিত ঠিকানা</h1><p>অভিজ্ঞ শিক্ষক, ছোট ব্যাচ, নিয়মিত পরীক্ষা ও অভিভাবক মিটিং — আপনার সন্তানের সাফল্য আমাদের অঙ্গীকার।</p></div>
<div class="wrap">
<div class="stats">
<div><b>১২+</b>অভিজ্ঞ শিক্ষক</div>
<div><b>৪৫০+</b>শিক্ষার্থী</div>
<div><b>৯৮%</b>পাসের হার</div>
<div><b>১০ বছর</b>অভিজ্ঞতা</div>
</div>
<h2>আমাদের কোর্সসমূহ</h2><p class="sub">৬ষ্ঠ থেকে দ্বাদশ শ্রেণি — বিজ্ঞান, ব্যবসায় শিক্ষা ও মানবিক</p>
<div class="courses">
<div class="course"><span class="cls">৬ষ্ঠ – ৮ম শ্রেণি</span><h3>সাধারণ কোর্স</h3><p>গণিত, ইংরেজি, বিজ্ঞান ও বাংলা — সব বিষয় একসাথে।</p><div class="fee">মাসিক ফি: ৳৮০০</div></div>
<div class="course"><span class="cls">৯ম – ১০ম শ্রেণি</span><h3>এসএসসি প্রস্তুতি</h3><p>বিজ্ঞান বিভাগের পূর্ণ প্রস্তুতি, মডেল টেস্টসহ।</p><div class="fee">মাসিক ফি: ৳১,২০০</div></div>
<div class="course"><span class="cls">একাদশ – দ্বাদশ</span><h3>এইচএসসি প্রস্তুতি</h3><p>পদার্থ, রসায়ন, গণিত ও জীববিজ্ঞান — গভীর প্রস্তুতি।</p><div class="fee">মাসিক ফি: ৳১,৫০০</div></div>
<div class="course"><span class="cls">বিশেষ ব্যাচ</span><h3>ইংরেজি স্পোকেন</h3><p>সপ্তাহে ৩ দিন — কথা বলা ও লেখার দক্ষতা।</p><div class="fee">মাসিক ফি: ৳৬০০</div></div>
</div>
<h2 style="margin-top:40px">ক্লাসের সময়সূচি</h2><p class="sub">সপ্তাহে ৬ দিন ক্লাস • শুক্রবার বন্ধ</p>
<table><tr><th>ব্যাচ</th><th>সময়</th><th>দিন</th></tr>
<tr><td>সকাল ব্যাচ</td><td>সকাল ৭টা — ১০টা</td><td>শনি – বৃহস্পতি</td></tr>
<tr><td>বিকেল ব্যাচ</td><td>বিকেল ৩টা — ৬টা</td><td>শনি – বৃহস্পতি</td></tr>
<tr><td>সন্ধ্যা ব্যাচ</td><td>সন্ধ্যা ৬টা — ৯টা</td><td>শনি – বৃহস্পতি</td></tr></table>
<h2 style="margin-top:40px">আমাদের শিক্ষকবৃন্দ</h2><p class="sub">ঢাকা বিশ্ববিদ্যালয় ও বুয়েটের মেধাবী শিক্ষক</p>
<div class="teachers">
<div class="t"><div class="av">র</div><b>মোঃ রফিকুল ইসলাম</b><br><span style="color:#64748b;font-size:13px">গণিত • ঢাকা বিশ্ববিদ্যালয়</span></div>
<div class="t"><div class="av">স</div><b>সালমা আক্তার</b><br><span style="color:#64748b;font-size:13px">ইংরেজি • রাজশাহী বিশ্ববিদ্যালয়</span></div>
<div class="t"><div class="av">ত</div><b>তানভীর হাসান</b><br><span style="color:#64748b;font-size:13px">পদার্থবিজ্ঞান • বুয়েট</span></div>
</div>
<div class="form" id="admit"><h2>ভর্তির ফর্ম</h2>
<form onsubmit="return admitNow(event)">
<label>শিক্ষার্থীর নাম</label><input required placeholder="শিক্ষার্থীর পুরো নাম">
<label>শ্রেণি</label><select><option>৬ষ্ঠ শ্রেণি</option><option>৭ম শ্রেণি</option><option>৮ম শ্রেণি</option><option>৯ম শ্রেণি</option><option>১০ম শ্রেণি</option><option>একাদশ শ্রেণি</option><option>দ্বাদশ শ্রেণি</option></select>
<label>অভিভাবকের ফোন</label><input required placeholder="01XXXXXXXXX">
<button type="submit">ভর্তির আবেদন জমা দিন</button>
</form><div id="done">✅ ধন্যবাদ! আপনার আবেদনটি পেয়েছি — ভর্তির বিষয়ে শীঘ্রই ফোন করা হবে।</div></div>
</div>
<footer>© ২০২৬ আলো কোচিং সেন্টার • রংপুর • ফোন: ০১৭০০-০০০০০০</footer>
<script>
function admitNow(e){e.preventDefault();document.getElementById('done').style.display='block';e.target.reset();return false;}
</script>
</body>
</html>`,
  },
  {
    id: 'mosque',
    title: 'মসজিদ নোটিশ বোর্ড',
    kind: 'Mosque',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'নামাজের সময়, নোটিশ ও দান — মসজিদের ওয়েবসাইট।',
    icon: MoonStar,
    color: 'from-teal-500/20 to-emerald-500/20 border-teal-500/30 text-teal-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0f766e">
<title>জামে মসজিদ — নামাজের সময় ও নোটিশ</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:#f0fdfa;color:#134e4a;line-height:1.7}
header{background:#0f766e;color:#fff;text-align:center;padding:34px 20px}
header .moon{font-size:40px}
header h1{font-size:30px;margin:6px 0}
header p{opacity:.9}
.wrap{max-width:960px;margin:0 auto;padding:28px 20px}
.notice{background:#fef3c7;border:1px solid #f59e0b;border-radius:14px;padding:16px 20px;margin-bottom:26px}
.notice b{color:#92400e}
h2{font-size:22px;margin-bottom:14px;color:#0f766e}
table{width:100%;background:#fff;border-collapse:collapse;border-radius:14px;overflow:hidden;font-size:15px;box-shadow:0 2px 10px rgba(0,0,0,.05)}
th{background:#0f766e;color:#fff;padding:12px;text-align:left}
td{padding:12px;border-bottom:1px solid #ccfbf1}
tr:last-child td{border-bottom:0}
td.now{background:#fef9c3;font-weight:800}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px;margin-top:28px}
.card{background:#fff;border:1px solid #99f6e4;border-radius:16px;padding:22px}
.card h3{margin-bottom:8px}
.card p{color:#475569;font-size:14px}
.card .big{font-size:24px;font-weight:800;color:#0f766e}
.donate{background:#0f766e;color:#fff;border-radius:20px;padding:32px 24px;text-align:center;margin-top:30px}
.donate a{display:inline-block;background:#fbbf24;color:#134e4a;padding:12px 30px;border-radius:999px;font-weight:800;text-decoration:none;margin-top:14px}
footer{background:#134e4a;color:#99f6e4;text-align:center;padding:22px;font-size:13px}
</style>
</head>
<body>
<header><div class="moon">☪️</div><h1>জামে মসজিদ, রংপুর</h1><p>বিসমিল্লাহির রাহমানির রাহিম — নামাজ কায়েম করুন, যাকাত দিন</p></header>
<div class="wrap">
<div class="notice">📢 <b>জরুরি নোটিশ:</b> আগামী শুক্রবার জুমার খুতবা শুরু দুপুর ১২:৩০ মিনিটে। মসজিদের নতুন ভবনের ছাদ ঢালাইয়ের কাজ চলছে — দানের জন্য কমিটির সঙ্গে যোগাযোগ করুন।</div>
<h2>🕌 আজকের নামাজের সময়সূচি</h2>
<table>
<tr><th>নামাজ</th><th>আজান</th><th>জামাত</th></tr>
<tr><td>ফজর</td><td>ভোর ৫:০০</td><td class="now">ভোর ৫:৩০</td></tr>
<tr><td>যোহর</td><td>দুপুর ১২:০০</td><td>দুপুর ১:১৫</td></tr>
<tr><td>আসর</td><td>বিকেল ৪:১৫</td><td>বিকেল ৪:৩০</td></tr>
<tr><td>মাগরিব</td><td>সন্ধ্যা ৫:৪৫</td><td>সন্ধ্যা ৫:৫০</td></tr>
<tr><td>এশা</td><td>রাত ৭:৩০</td><td>রাত ৮:০০</td></tr>
<tr><td>জুমা</td><td>দুপুর ১২:০০</td><td>দুপুর ১:০০</td></tr>
</table>
<div class="grid">
<div class="card"><h3>📖 কুরআন শিক্ষা</h3><p>শিশুদের জন্য প্রতিদিন বাদ ফজর ও বাদ আসর কুরআন শিক্ষার ক্লাস। ভর্তি সম্পূর্ণ ফ্রি।</p></div>
<div class="card"><h3>🕌 ইমাম ও খতিব</h3><p><b>হাফেজ মাওলানা আব্দুল করিম</b><br>ফোন: ০১৭০০-০০০০০০</p></div>
<div class="card"><h3>💰 এ মাসের দান</h3><p class="big">৳৮৫,৪০০</p><p>লক্ষ্য: ৳২,০০,০০০ (নতুন ভবন)</p></div>
<div class="card"><h3>📅 আসন্ন অনুষ্ঠান</h3><p>ইসলামিক আলোচনা সভা — আগামী শুক্রবার বাদ মাগরিব। সবার আমন্ত্রণ রইল।</p></div>
</div>
<div class="donate"><h2 style="color:#fff">মসজিদের উন্নয়নে দান করুন</h2><p>সদকায়ে জারিয়া — আপনার দানেই গড়ে উঠবে আল্লাহর ঘর।</p><a href="tel:01700000000">দান করতে কল করুন</a></div>
</div>
<footer>© ২০২৬ জামে মসজিদ কমিটি • রংপুর • সভাপতি: মোঃ আব্দুর রহিম</footer>
</body>
</html>`,
  },
  {
    id: 'cv',
    title: 'সিভি / রিজিউমে',
    kind: 'CV',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'পরিষ্কার, প্রিন্ট-বান্ধব সিভি — চাকরির আবেদনের জন্য।',
    icon: FileText,
    color: 'from-slate-500/20 to-gray-500/20 border-slate-500/30 text-slate-300',
    html: `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#1e293b">
<title>Mehedi Hasan — CV / Resume</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Georgia,'Times New Roman',serif;color:#1e293b;background:#f1f5f9;line-height:1.6}
.page{max-width:820px;margin:24px auto;background:#fff;padding:48px 56px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:32px;letter-spacing:.5px}
.role{color:#475569;font-size:17px;margin:4px 0 12px}
.contact{font-size:13px;color:#64748b;border-bottom:2px solid #1e293b;padding-bottom:14px;margin-bottom:22px}
.contact span{margin-right:14px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:2px;color:#1e293b;border-bottom:1px solid #cbd5e1;padding-bottom:6px;margin:26px 0 12px}
p{font-size:14px}
.job{margin-bottom:16px}
.job .row{display:flex;justify-content:space-between;font-size:14px}
.job .row b{font-size:15px}
.job .row i{color:#64748b}
.job ul{margin:6px 0 0 18px;font-size:14px;color:#334155}
.skills{display:flex;flex-wrap:wrap;gap:8px}
.skills span{background:#f1f5f9;border:1px solid #cbd5e1;border-radius:999px;padding:4px 14px;font-size:13px}
.edu{margin-bottom:10px;font-size:14px}
.print-btn{text-align:center;margin:16px 0}
.print-btn button{background:#1e293b;color:#fff;border:0;padding:11px 28px;border-radius:999px;font-weight:700;cursor:pointer;font-size:14px}
@media print{body{background:#fff}.page{box-shadow:none;margin:0;max-width:none}.print-btn{display:none}}
@media(max-width:640px){.page{padding:28px 22px}}
</style>
</head>
<body>
<div class="print-btn"><button onclick="window.print()">🖨️ Print / Save as PDF</button></div>
<div class="page">
<h1>Mehedi Hasan</h1>
<div class="role">Small Business Owner &amp; Web Developer</div>
<div class="contact"><span>📍 Rangpur, Bangladesh</span><span>📞 01700-000000</span><span>✉️ hello@example.com</span><span>🌐 facebook.com/mehedihasan</span></div>
<h2>Profile</h2>
<p>Entrepreneur and self-taught web developer from Rangpur with 3+ years of experience running a retail shop and building websites for local businesses. I combine practical business sense with modern web skills — landing pages, online shops and PWA apps that work on any phone.</p>
<h2>Experience</h2>
<div class="job"><div class="row"><b>Owner — Munsi Store</b><i>2023 — Present</i></div><ul><li>Run a retail shop in Rangpur; manage sourcing, pricing and daily sales.</li><li>Built the shop's online store with cart, bKash payment and order tracking.</li><li>Grew monthly revenue by 40% through Facebook marketing and WhatsApp orders.</li></ul></div>
<div class="job"><div class="row"><b>Freelance Web Developer</b><i>2024 — Present</i></div><ul><li>Delivered 10+ websites for local shops, coaching centres and restaurants.</li><li>Specialise in fast, mobile-first sites that work offline as PWA apps.</li></ul></div>
<div class="job"><div class="row"><b>Handmade Crochet Exporter</b><i>2025 — Present</i></div><ul><li>Export handmade crochet products to buyers in the USA and UK.</li><li>Manage product photography, wholesale pricing and international shipping.</li></ul></div>
<h2>Skills</h2>
<div class="skills"><span>HTML / CSS / JavaScript</span><span>React</span><span>PWA</span><span>Firebase</span><span>GitHub</span><span>Digital Marketing</span><span>Facebook Ads</span><span>Wholesale Sourcing</span></div>
<h2>Education</h2>
<div class="edu"><b>HSC — Business Studies</b><br>Rangpur Govt. College • 2023</div>
<div class="edu"><b>SSC — Science</b><br>Rangpur Zilla School • 2021</div>
<h2>Languages</h2>
<p>Bengali (native) • English (working proficiency)</p>
<h2>References</h2>
<p>Available on request.</p>
</div>
<div class="print-btn"><button onclick="window.print()">🖨️ Print / Save as PDF</button></div>
</body>
</html>`,
  },
  {
    id: 'event',
    title: 'বিয়ে / ইভেন্ট আমন্ত্রণ',
    kind: 'Event',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'কাউন্টডাউন, অনুষ্ঠানসূচি ও RSVP — বিয়ের আমন্ত্রণপত্র।',
    icon: PartyPopper,
    color: 'from-pink-500/20 to-rose-500/20 border-pink-500/30 text-pink-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#be185d">
<title>মেহেদী ❤️ ফাতেমা — বিয়ের আমন্ত্রণ</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:#fff1f2;color:#4c0519;line-height:1.7;text-align:center}
.hero{background:linear-gradient(160deg,#fbcfe8,#fda4af 55%,#f9a8d4);padding:70px 20px 60px}
.hero .ring{font-size:52px}
.hero h1{font-size:40px;margin:10px 0 4px}
.hero p{font-size:18px}
.hero .date{display:inline-block;background:#fff;color:#be185d;font-weight:800;padding:8px 22px;border-radius:999px;margin-top:18px}
.count{display:flex;gap:12px;justify-content:center;margin:28px 0 8px;flex-wrap:wrap}
.count div{background:#fff;border-radius:16px;padding:16px 10px;min-width:84px;box-shadow:0 4px 16px rgba(190,24,93,.15)}
.count b{font-size:30px;color:#be185d;display:block;line-height:1.1}
.count span{font-size:12px;color:#9f1239}
.wrap{max-width:860px;margin:0 auto;padding:36px 20px}
.card{background:#fff;border:1px solid #fbcfe8;border-radius:20px;padding:28px;margin-bottom:20px}
.card h2{color:#be185d;margin-bottom:10px}
.program{text-align:left;max-width:480px;margin:0 auto}
.program div{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px dashed #fbcfe8;font-size:15px}
.program div:last-child{border-bottom:0}
.venue{font-size:15px;color:#6b7280}
.venue b{color:#4c0519}
form{max-width:440px;margin:0 auto;text-align:left}
form label{display:block;font-size:14px;font-weight:700;margin:12px 0 4px}
form input,form select{width:100%;padding:11px 14px;border:1px solid #f9a8d4;border-radius:10px;font-size:15px;font-family:inherit}
form button{width:100%;background:#be185d;color:#fff;border:0;padding:13px;border-radius:999px;font-weight:800;font-size:16px;cursor:pointer;margin-top:20px}
#done{display:none;background:#fdf2f8;border:1px solid #f9a8d4;color:#9d174d;border-radius:12px;padding:14px;margin-top:16px;text-align:center;font-weight:700}
footer{padding:26px;color:#9f1239;font-size:14px}
@media(max-width:640px){.hero h1{font-size:30px}}
</style>
</head>
<body>
<div class="hero">
<div class="ring">💍</div>
<h1>মেহেদী ❤️ ফাতেমা</h1>
<p>আমাদের বিয়েতে আপনাদের সাদর আমন্ত্রণ</p>
<span class="date">📅 শুক্রবার, ১২ ডিসেম্বর ২০২৬</span>
<div class="count">
<div><b id="d">--</b><span>দিন</span></div>
<div><b id="h">--</b><span>ঘণ্টা</span></div>
<div><b id="m">--</b><span>মিনিট</span></div>
<div><b id="s">--</b><span>সেকেন্ড</span></div>
</div>
</div>
<div class="wrap">
<div class="card"><h2>💌 আমন্ত্রণ</h2><p>আলহামদুলিল্লাহ, আল্লাহর অশেষ রহমতে আমাদের বিয়ের দিন ঠিক হয়েছে। এই আনন্দের দিনে আপনার উপস্থিতি আমাদের জন্য সবচেয়ে বড় উপহার। আপনি ও আপনার পরিবার সাদরে আমন্ত্রিত।</p></div>
<div class="card"><h2>🎉 অনুষ্ঠানসূচি</h2><div class="program">
<div><span>🎊 হলুদ</span><b>বৃহস্পতিবার, সন্ধ্যা ৭টা</b></div>
<div><span>💍 বিয়ে (আকদ)</span><b>শুক্রবার, সকাল ১১টা</b></div>
<div><span>🍽️ ওয়ালিমা / ভোজ</span><b>শুক্রবার, দুপুর ১টা</b></div>
<div><span>🎁 বৌভাত</span><b>শনিবার, সন্ধ্যা ৭টা</b></div>
</div></div>
<div class="card"><h2>📍 ভেন্যু</h2><p class="venue"><b>রংপুর কমিউনিটি সেন্টার</b><br>জাহাজ কোম্পানি মোড়, রংপুর<br>পার্কিংয়ের ব্যবস্থা আছে</p></div>
<div class="card"><h2>✅ উপস্থিতি জানান (RSVP)</h2>
<form onsubmit="return rsvpNow(event)">
<label>আপনার নাম</label><input required placeholder="আপনার নাম">
<label>কতজন আসবেন?</label><select><option>১ জন</option><option>২ জন</option><option>৩ জন</option><option>৪+ জন</option></select>
<button type="submit">উপস্থিতি নিশ্চিত করুন</button>
</form><div id="done">❤️ ধন্যবাদ! আপনার উপস্থিতির অপেক্ষায় থাকব।</div></div>
</div>
<footer>মেহেদী ও ফাতেমা পরিবার • রংপুর, বাংলাদেশ</footer>
<script>
var target=new Date('2026-12-12T11:00:00+06:00').getTime();
function tick(){
var diff=target-Date.now();
if(diff<0){diff=0;}
document.getElementById('d').textContent=Math.floor(diff/86400000);
document.getElementById('h').textContent=Math.floor(diff/3600000)%24;
document.getElementById('m').textContent=Math.floor(diff/60000)%60;
document.getElementById('s').textContent=Math.floor(diff/1000)%60;
}
tick();setInterval(tick,1000);
function rsvpNow(e){e.preventDefault();document.getElementById('done').style.display='block';e.target.reset();return false;}
</script>
</body>
</html>`,
  },
  {
    id: 'blog',
    title: 'ব্যক্তিগত ব্লগ',
    kind: 'Blog',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'লেখা, ক্যাটাগরি ও খোঁজ — নিজের ব্লগ শুরু করুন।',
    icon: Newspaper,
    color: 'from-violet-500/20 to-purple-500/20 border-violet-500/30 text-violet-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#6d28d9">
<title>মেহেদীর ডায়েরি — গল্প, ব্যবসা ও জীবন</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:#faf5ff;color:#1e1b4b;line-height:1.75}
header{background:#fff;border-bottom:1px solid #e9d5ff;position:sticky;top:0;z-index:10}
.nav{max-width:960px;margin:0 auto;padding:16px 20px;display:flex;justify-content:space-between;align-items:center}
.logo{font-size:21px;font-weight:800;color:#6d28d9}
.nav input{padding:9px 16px;border:1px solid #d8b4fe;border-radius:999px;font-size:14px;font-family:inherit;width:200px}
.hero{text-align:center;padding:52px 20px 40px}
.hero h1{font-size:34px;color:#4c1d95}
.hero p{color:#6b7280;max-width:520px;margin:10px auto 0}
.wrap{max-width:960px;margin:0 auto;padding:20px}
.filters{display:flex;gap:8px;flex-wrap:wrap;justify-content:center;margin-bottom:26px}
.filters button{border:1px solid #d8b4fe;background:#fff;color:#6d28d9;padding:8px 16px;border-radius:999px;cursor:pointer;font-weight:700;font-size:13px}
.filters button.on{background:#7c3aed;color:#fff}
.posts{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}
.post{background:#fff;border:1px solid #e9d5ff;border-radius:16px;overflow:hidden;cursor:pointer}
.post .cover{height:130px;display:flex;align-items:center;justify-content:center;font-size:48px;background:linear-gradient(135deg,#ddd6fe,#f5d0fe)}
.post .body{padding:20px}
.post .meta{font-size:12px;color:#9333ea;font-weight:700}
.post h3{font-size:17px;margin:6px 0}
.post p{color:#6b7280;font-size:14px}
.post .read{color:#7c3aed;font-weight:700;font-size:13px;margin-top:10px;display:block}
#article{display:none;background:#fff;border:1px solid #e9d5ff;border-radius:16px;padding:30px;margin-bottom:20px}
#article h2{color:#4c1d95;margin-bottom:10px}
#article p{color:#475569;font-size:15px;margin-bottom:12px}
#article button{background:#7c3aed;color:#fff;border:0;padding:9px 20px;border-radius:999px;cursor:pointer;font-weight:700}
.about{background:#4c1d95;color:#fff;border-radius:20px;padding:30px;text-align:center;margin-top:34px}
.about h2{color:#fff}
footer{text-align:center;color:#a78bfa;padding:26px;font-size:13px}
</style>
</head>
<body>
<header><div class="nav"><div class="logo">✍️ মেহেদীর ডায়েরি</div><input id="search" placeholder="🔍 লেখা খুঁজুন..." oninput="render()"></div></header>
<div class="hero"><h1>গল্প, ব্যবসা আর জীবনের কথা</h1><p>রংপুরের এক ছোট ব্যবসায়ীর দৈনন্দিন অভিজ্ঞতা — সফলতা, ব্যর্থতা আর শেখার গল্প।</p></div>
<div class="wrap">
<div class="filters">
<button class="on" onclick="setCat('all',this)">সব লেখা</button>
<button onclick="setCat('business',this)">ব্যবসা</button>
<button onclick="setCat('life',this)">জীবন</button>
<button onclick="setCat('tech',this)">প্রযুক্তি</button>
</div>
<div id="article"></div>
<div class="posts" id="posts"></div>
<div class="about"><h2>লেখক সম্পর্কে</h2><p>মেহেদী হাসান — রংপুরের ছোট ব্যবসায়ী ও ওয়েব ডেভেলপার। ব্যবসা, প্রযুক্তি আর জীবন নিয়ে লিখতে ভালোবাসি।</p></div>
</div>
<footer>© ২০২৬ মেহেদীর ডায়েরি • রংপুর</footer>
<script>
var posts=[
{cat:'business',tag:'ব্যবসা • ২৫ নভেম্বর ২০২৬',emoji:'🛒',title:'ছোট দোকান থেকে অনলাইন শপ — আমার যাত্রা',body:'দোকানের পাশাপাশি অনলাইনে বিক্রি শুরু করাটা ছিল আমার জীবনের সেরা সিদ্ধান্তগুলোর একটি। প্রথমে ভয় লাগছিল — কে কিনবে? ডেলিভারি কীভাবে হবে? কিন্তু ফেসবুক পেজ আর হোয়াটসঅ্যাপে অর্ডার নেওয়া শুরু করতেই বুঝলাম, গ্রাহকরা আসলে অনলাইনেই কিনতে চায়। আজ আমার মাসিক বিক্রির ৪০% আসে অনলাইন থেকে।'},
{cat:'tech',tag:'প্রযুক্তি • ২০ নভেম্বর ২০২৬',emoji:'💻',title:'কোডিং না জেনেও নিজের ওয়েবসাইট বানালাম',body:'আগে ভাবতাম ওয়েবসাইট বানাতে হলে প্রোগ্রামার হতে হয়। এখন AI টুল দিয়ে নিজের দোকানের ওয়েবসাইট নিজেই বানাই — পণ্যের ছবি, দাম, অর্ডার ফর্ম সব। প্রযুক্তি এখন আর শুধু বড়দের নয়, আমাদের মতো ছোট ব্যবসায়ীদেরও।'},
{cat:'life',tag:'জীবন • ১৫ নভেম্বর ২০২৬',emoji:'🌅',title:'ভোর ৫টায় ওঠার অভ্যাস যেভাবে বদলে দিল দিন',body:'গত ছয় মাস ধরে ভোর ৫টায় উঠি। প্রথম এক সপ্তাহ কষ্ট হয়েছে, তারপর অভ্যাস হয়ে গেছে। সকালে দোকান খোলার আগে দুই ঘণ্টা নিজের কাজ — পড়াশোনা, পরিকল্পনা, হিসাব। এই দুই ঘণ্টাই আমার দিনের সবচেয়ে মূল্যবান সময়।'},
{cat:'business',tag:'ব্যবসা • ১০ নভেম্বর ২০২৬',emoji:'💰',title:'পাইকারি কিনতে গিয়ে যা শিখলাম',body:'প্রথমবার পাইকারি বাজারে গিয়ে ঠকেছিলাম — দাম বেশি দিয়ে কিনেছিলাম। এখন তিনজন পাইকারের কাছে দাম যাচাই করে কিনি, আর সবসময় নগদে কিনে ছাড় নিই। ছোট ব্যবসায় লাভের অর্ধেকটাই আসে সঠিক দামে কেনা থেকে।'},
{cat:'tech',tag:'প্রযুক্তি • ৫ নভেম্বর ২০২৬',emoji:'📱',title:'ফেসবুক পেজ দিয়ে বিক্রি বাড়ানোর ৫টি উপায়',body:'নিয়মিত ছবি পোস্ট, গ্রাহকের রিভিউ শেয়ার, লাইভে পণ্য দেখানো, দ্রুত মেসেজের উত্তর আর সৎ দাম — এই পাঁচটি কাজই আমার পেজের বিক্রি দ্বিগুণ করেছে। বিজ্ঞাপনে টাকা খরচের আগে এগুলো চেষ্টা করে দেখুন।'},
{cat:'life',tag:'জীবন • ১ নভেম্বর ২০২৬',emoji:'📖',title:'বই পড়ার অভ্যাস: মাসে একটি বই',body:'বছরের শুরুতে ঠিক করেছিলাম মাসে অন্তত একটি বই পড়ব। ব্যবসা নিয়ে বই পড়ে শিখেছি হিসাব রাখা, গ্রাহক ধরে রাখা আর ধৈর্যের মূল্য। বই আমার সবচেয়ে সস্তা শিক্ষক।'}
];
var currentCat='all';
function setCat(c,btn){
currentCat=c;
document.querySelectorAll('.filters button').forEach(function(b){b.classList.remove('on')});
btn.classList.add('on');render();
}
function openPost(i){
var p=posts[i];
var a=document.getElementById('article');
a.style.display='block';
a.innerHTML='<div style="font-size:13px;color:#9333ea;font-weight:700">'+p.tag+'</div><h2>'+p.title+'</h2><p>'+p.body+'</p><button onclick="document.getElementById(\'article\').style.display=\'none\'">বন্ধ করুন ✕</button>';
a.scrollIntoView({behavior:'smooth'});
}
function render(){
var q=(document.getElementById('search').value||'').toLowerCase();
var list=posts.filter(function(p){return (currentCat==='all'||p.cat===currentCat)&&(p.title.toLowerCase().indexOf(q)>=0||p.body.toLowerCase().indexOf(q)>=0);});
var box=document.getElementById('posts');box.innerHTML='';
if(!list.length){box.innerHTML='<p style="color:#6b7280">কোনো লেখা পাওয়া যায়নি — অন্য কিছু খুঁজে দেখুন।</p>';return;}
list.forEach(function(p){
var idx=posts.indexOf(p);
var el=document.createElement('div');el.className='post';el.onclick=function(){openPost(idx);};
el.innerHTML='<div class="cover">'+p.emoji+'</div><div class="body"><div class="meta">'+p.tag+'</div><h3>'+p.title+'</h3><p>'+p.body.slice(0,90)+'…</p><span class="read">পুরোটা পড়ুন →</span></div>';
box.appendChild(el);
});
}
render();
</script>
</body>
</html>`,
  },
  {
    id: 'link-in-bio',
    title: 'লিংক-ইন-বায়ো পেজ',
    kind: 'Link in Bio',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'সব সোশ্যাল লিংক এক পেজে — বায়ো লিংকের জন্য।',
    icon: Link2,
    color: 'from-cyan-500/20 to-sky-500/20 border-cyan-500/30 text-cyan-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0e7490">
<title>মেহেদী হাসান — সব লিংক এক জায়গায়</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:linear-gradient(180deg,#164e63,#0e7490 45%,#155e75);min-height:100vh;color:#fff;text-align:center;padding:40px 18px}
.card{max-width:440px;margin:0 auto}
.avatar{width:104px;height:104px;border-radius:50%;background:#fff;color:#0e7490;display:flex;align-items:center;justify-content:center;font-size:42px;font-weight:800;margin:0 auto 14px;border:4px solid rgba(255,255,255,.5)}
h1{font-size:24px}
.sub{opacity:.85;font-size:14px;margin:6px 0 4px}
.bio{font-size:14px;opacity:.9;max-width:340px;margin:10px auto 26px}
.links a{display:flex;align-items:center;gap:12px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.35);color:#fff;text-decoration:none;padding:15px 20px;border-radius:16px;margin-bottom:12px;font-weight:700;font-size:15px;transition:background .2s}
.links a:hover{background:rgba(255,255,255,.28)}
.links .ic{font-size:22px;width:30px;text-align:center}
.links .go{margin-left:auto;opacity:.7}
.shop{background:#fff;color:#0e7490}
.shop:hover{background:#f0f9ff}
footer{opacity:.7;font-size:12px;margin-top:28px}
</style>
</head>
<body>
<div class="card">
<div class="avatar">MH</div>
<h1>মেহেদী হাসান</h1>
<p class="sub">@mehedihasan • রংপুর, বাংলাদেশ</p>
<p class="bio">ছোট ব্যবসায়ী ও ওয়েব ডেভেলপার 🛒 হাতে বানানো ক্রোশে, রেজার ও নিত্যপ্রয়োজনীয় পণ্য — অনলাইনে অর্ডার করুন 👇</p>
<div class="links">
<a class="shop" href="https://wa.me/8801700000000" target="_blank" rel="noopener"><span class="ic">🛒</span>মুনসি স্টোর — অনলাইনে অর্ডার করুন<span class="go">→</span></a>
<a href="https://facebook.com/mehedihasan" target="_blank" rel="noopener"><span class="ic">📘</span>ফেসবুক পেজ<span class="go">→</span></a>
<a href="https://wa.me/8801700000000" target="_blank" rel="noopener"><span class="ic">💬</span>হোয়াটসঅ্যাপে মেসেজ করুন<span class="go">→</span></a>
<a href="https://youtube.com/@mehedihasan" target="_blank" rel="noopener"><span class="ic">▶️</span>ইউটিউব চ্যানেল<span class="go">→</span></a>
<a href="https://instagram.com/mehedihasan" target="_blank" rel="noopener"><span class="ic">📸</span>ইনস্টাগ্রাম<span class="go">→</span></a>
<a href="https://tiktok.com/@mehedihasan" target="_blank" rel="noopener"><span class="ic">🎵</span>টিকটক<span class="go">→</span></a>
<a href="mailto:hello@example.com"><span class="ic">✉️</span>ইমেইল করুন<span class="go">→</span></a>
</div>
<footer>© ২০২৬ মেহেদী হাসান • সব লিংক এক জায়গায়</footer>
</div>
</body>
</html>`,
  },
  {
    id: 'coming-soon',
    title: 'শীঘ্রই আসছে পেজ',
    kind: 'Coming Soon',
    badge: 'টেমপ্লেট • ফ্রি',
    description: 'কাউন্টডাউন ও নোটিফাই ফর্ম — লঞ্চের আগের পেজ।',
    icon: Timer,
    color: 'from-orange-500/20 to-amber-500/20 border-orange-500/30 text-orange-300',
    html: `<!DOCTYPE html>
<html lang="bn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#0f172a">
<title>শীঘ্রই আসছে — সহজ বাজার</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Hind Siliguri','Noto Sans Bengali',system-ui,sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:32px 18px}
.box{max-width:620px}
.badge{display:inline-block;background:#4f46e5;color:#fff;font-weight:800;font-size:13px;padding:6px 18px;border-radius:999px;margin-bottom:22px}
h1{font-size:44px;color:#fff;line-height:1.2}
h1 span{color:#818cf8}
p{color:#94a3b8;margin:14px auto 30px;max-width:480px}
.count{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-bottom:34px}
.count div{background:#1e293b;border:1px solid #334155;border-radius:16px;padding:18px 10px;min-width:88px}
.count b{font-size:32px;color:#fff;display:block;line-height:1.1}
.count span{font-size:12px;color:#94a3b8}
form{display:flex;gap:10px;max-width:460px;margin:0 auto;flex-wrap:wrap;justify-content:center}
form input{flex:1;min-width:220px;padding:13px 18px;border-radius:999px;border:1px solid #334155;background:#1e293b;color:#fff;font-size:15px;font-family:inherit}
form button{background:#4f46e5;color:#fff;border:0;padding:13px 28px;border-radius:999px;font-weight:800;cursor:pointer;font-size:15px}
#done{display:none;background:#064e3b;border:1px solid #059669;color:#a7f3d0;border-radius:12px;padding:13px;margin:18px auto 0;max-width:460px;font-weight:700}
.social{margin-top:34px;font-size:14px}
.social a{color:#818cf8;text-decoration:none;margin:0 10px}
footer{margin-top:28px;color:#64748b;font-size:13px}
@media(max-width:640px){h1{font-size:32px}}
</style>
</head>
<body>
<div class="box">
<span class="badge">🚀 নতুন কিছু আসছে</span>
<h1>সহজ বাজার<br><span>শীঘ্রই আসছে</span></h1>
<p>আমরা নতুন অনলাইন শপ তৈরি করছি — আরও পণ্য, আরও ভালো দাম, আরও দ্রুত ডেলিভারি। লঞ্চের দিন প্রথম জানতে ইমেইল দিন।</p>
<div class="count">
<div><b id="d">--</b><span>দিন</span></div>
<div><b id="h">--</b><span>ঘণ্টা</span></div>
<div><b id="m">--</b><span>মিনিট</span></div>
<div><b id="s">--</b><span>সেকেন্ড</span></div>
</div>
<form onsubmit="return notifyMe(event)">
<input type="email" required placeholder="আপনার ইমেইল ঠিকানা">
<button type="submit">জানিয়ে দিন 🔔</button>
</form>
<div id="done">✅ ধন্যবাদ! লঞ্চের দিন আপনাকেই প্রথম জানানো হবে।</div>
<div class="social"><a href="https://facebook.com/mehedihasan">ফেসবুক</a><a href="https://wa.me/8801700000000">হোয়াটসঅ্যাপ</a><a href="mailto:hello@example.com">ইমেইল</a></div>
<footer>© ২০২৬ সহজ বাজার • রংপুর, বাংলাদেশ</footer>
</div>
<script>
var target=new Date('2026-12-15T10:00:00+06:00').getTime();
function tick(){
var diff=target-Date.now();
if(diff<0){diff=0;}
document.getElementById('d').textContent=Math.floor(diff/86400000);
document.getElementById('h').textContent=Math.floor(diff/3600000)%24;
document.getElementById('m').textContent=Math.floor(diff/60000)%60;
document.getElementById('s').textContent=Math.floor(diff/1000)%60;
}
tick();setInterval(tick,1000);
function notifyMe(e){e.preventDefault();document.getElementById('done').style.display='block';e.target.reset();return false;}
</script>
</body>
</html>`,
  },
];

export function getTemplateById(id: string): StaticTemplate | undefined {
  return STATIC_TEMPLATES.find((t) => t.id === id);
}

/**
 * Structural check used by the zero-key verification script: a template is
 * a complete standalone document (doctype, html/head/body/title, closing
 * tag) with inline CSS only — no external stylesheet/script/image host and
 * no provider (model) call of any kind.
 */
export function isCompleteHtml(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.trimStart().startsWith('<!doctype html>') &&
    lower.includes('<html') &&
    lower.includes('</html>') &&
    lower.includes('<head>') &&
    lower.includes('</head>') &&
    lower.includes('<body>') &&
    lower.includes('</body>') &&
    lower.includes('<title>') &&
    lower.includes('</title>') &&
    html.length > 2000
  );
}
