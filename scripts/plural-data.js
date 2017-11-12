// Generated from the https://github.com/eemeli/IntlPluralRules/ outdated polyfill
const pluralRulesDb = (function() {

const cp = [
  function(n) {
    return 'other';
  },
  function(n) {
    return (n == 1) ? 'one' : 'other';
  },
  function(n) {
    return ((n == 0
            || n == 1)) ? 'one' : 'other';
  },
  function(n) {
    var s = String(n).split('.'), v0 = !s[1];
    return (n == 1 && v0) ? 'one' : 'other';
  }
];

return {
  cardinal: {
    af: cp[1],
    ak: cp[2],
    am: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    },
    ar: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n100 = t0 && s[0].slice(-2);
      return (n == 0) ? 'zero'
          : (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : ((n100 >= 3 && n100 <= 10)) ? 'few'
          : ((n100 >= 11 && n100 <= 99)) ? 'many'
          : 'other';
    },
    as: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    },
    asa: cp[1],
    ast: cp[3],
    az: cp[1],
    be: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1), n100 = t0 && s[0].slice(-2);
      return (n10 == 1 && n100 != 11) ? 'one'
          : ((n10 >= 2 && n10 <= 4) && (n100 < 12
              || n100 > 14)) ? 'few'
          : (t0 && n10 == 0 || (n10 >= 5 && n10 <= 9)
              || (n100 >= 11 && n100 <= 14)) ? 'many'
          : 'other';
    },
    bem: cp[1],
    bez: cp[1],
    bg: cp[1],
    bh: cp[2],
    bm: cp[0],
    bn: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    },
    bo: cp[0],
    br: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1), n100 = t0 && s[0].slice(-2),
          n1000000 = t0 && s[0].slice(-6);
      return (n10 == 1 && n100 != 11 && n100 != 71 && n100 != 91) ? 'one'
          : (n10 == 2 && n100 != 12 && n100 != 72 && n100 != 92) ? 'two'
          : (((n10 == 3 || n10 == 4) || n10 == 9) && (n100 < 10
              || n100 > 19) && (n100 < 70 || n100 > 79) && (n100 < 90
              || n100 > 99)) ? 'few'
          : (n != 0 && t0 && n1000000 == 0) ? 'many'
          : 'other';
    },
    brx: cp[1],
    bs: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i10 = i.slice(-1), i100 = i.slice(-2), f10 = f.slice(-1), f100 = f.slice(-2);
      return (v0 && i10 == 1 && i100 != 11
              || f10 == 1 && f100 != 11) ? 'one'
          : (v0 && (i10 >= 2 && i10 <= 4) && (i100 < 12 || i100 > 14)
              || (f10 >= 2 && f10 <= 4) && (f100 < 12
              || f100 > 14)) ? 'few'
          : 'other';
    },
    ca: cp[3],
    ce: cp[1],
    cgg: cp[1],
    chr: cp[1],
    ckb: cp[1],
    cs: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1];
      return (n == 1 && v0) ? 'one'
          : ((i >= 2 && i <= 4) && v0) ? 'few'
          : (!v0) ? 'many'
          : 'other';
    },
    cy: function(n) {
      return (n == 0) ? 'zero'
          : (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : (n == 3) ? 'few'
          : (n == 6) ? 'many'
          : 'other';
    },
    da: function(n) {
      var s = String(n).split('.'), i = s[0], t0 = Number(s[0]) == n;
      return (n == 1 || !t0 && (i == 0
              || i == 1)) ? 'one' : 'other';
    },
    de: cp[3],
    dsb: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i100 = i.slice(-2), f100 = f.slice(-2);
      return (v0 && i100 == 1
              || f100 == 1) ? 'one'
          : (v0 && i100 == 2
              || f100 == 2) ? 'two'
          : (v0 && (i100 == 3 || i100 == 4) || (f100 == 3
              || f100 == 4)) ? 'few'
          : 'other';
    },
    dv: cp[1],
    dz: cp[0],
    ee: cp[1],
    el: cp[1],
    en: cp[3],
    eo: cp[1],
    es: cp[1],
    et: cp[3],
    eu: cp[1],
    fa: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    },
    ff: function(n) {
      return (n >= 0 && n < 2) ? 'one' : 'other';
    },
    fi: cp[3],
    fil: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i10 = i.slice(-1), f10 = f.slice(-1);
      return (v0 && (i == 1 || i == 2 || i == 3)
              || v0 && i10 != 4 && i10 != 6 && i10 != 9
              || !v0 && f10 != 4 && f10 != 6 && f10 != 9) ? 'one' : 'other';
    },
    fo: cp[1],
    fr: function(n) {
      return (n >= 0 && n < 2) ? 'one' : 'other';
    },
    fur: cp[1],
    fy: cp[3],
    ga: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n;
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : ((t0 && n >= 3 && n <= 6)) ? 'few'
          : ((t0 && n >= 7 && n <= 10)) ? 'many'
          : 'other';
    },
    gd: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n;
      return ((n == 1
              || n == 11)) ? 'one'
          : ((n == 2
              || n == 12)) ? 'two'
          : (((t0 && n >= 3 && n <= 10)
              || (t0 && n >= 13 && n <= 19))) ? 'few'
          : 'other';
    },
    gl: cp[3],
    gsw: cp[1],
    gu: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    },
    guw: cp[2],
    gv: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1], i10 = i.slice(-1),
          i100 = i.slice(-2);
      return (v0 && i10 == 1) ? 'one'
          : (v0 && i10 == 2) ? 'two'
          : (v0 && (i100 == 0 || i100 == 20 || i100 == 40 || i100 == 60
              || i100 == 80)) ? 'few'
          : (!v0) ? 'many'
          : 'other';
    },
    ha: cp[1],
    haw: cp[1],
    he: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1], t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1);
      return (n == 1 && v0) ? 'one'
          : (i == 2 && v0) ? 'two'
          : (v0 && (n < 0
              || n > 10) && t0 && n10 == 0) ? 'many'
          : 'other';
    },
    hi: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    },
    hr: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i10 = i.slice(-1), i100 = i.slice(-2), f10 = f.slice(-1), f100 = f.slice(-2);
      return (v0 && i10 == 1 && i100 != 11
              || f10 == 1 && f100 != 11) ? 'one'
          : (v0 && (i10 >= 2 && i10 <= 4) && (i100 < 12 || i100 > 14)
              || (f10 >= 2 && f10 <= 4) && (f100 < 12
              || f100 > 14)) ? 'few'
          : 'other';
    },
    hsb: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i100 = i.slice(-2), f100 = f.slice(-2);
      return (v0 && i100 == 1
              || f100 == 1) ? 'one'
          : (v0 && i100 == 2
              || f100 == 2) ? 'two'
          : (v0 && (i100 == 3 || i100 == 4) || (f100 == 3
              || f100 == 4)) ? 'few'
          : 'other';
    },
    hu: cp[1],
    hy: function(n) {
      return (n >= 0 && n < 2) ? 'one' : 'other';
    },
    id: cp[0],
    ig: cp[0],
    ii: cp[0],
    in: cp[0],
    is: function(n) {
      var s = String(n).split('.'), i = s[0], t0 = Number(s[0]) == n,
          i10 = i.slice(-1), i100 = i.slice(-2);
      return (t0 && i10 == 1 && i100 != 11
              || !t0) ? 'one' : 'other';
    },
    it: cp[3],
    iu: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    iw: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1], t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1);
      return (n == 1 && v0) ? 'one'
          : (i == 2 && v0) ? 'two'
          : (v0 && (n < 0
              || n > 10) && t0 && n10 == 0) ? 'many'
          : 'other';
    },
    ja: cp[0],
    jbo: cp[0],
    jgo: cp[1],
    ji: cp[3],
    jmc: cp[1],
    jv: cp[0],
    jw: cp[0],
    ka: cp[1],
    kab: function(n) {
      return (n >= 0 && n < 2) ? 'one' : 'other';
    },
    kaj: cp[1],
    kcg: cp[1],
    kde: cp[0],
    kea: cp[0],
    kk: cp[1],
    kkj: cp[1],
    kl: cp[1],
    km: cp[0],
    kn: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    },
    ko: cp[0],
    ks: cp[1],
    ksb: cp[1],
    ksh: function(n) {
      return (n == 0) ? 'zero'
          : (n == 1) ? 'one'
          : 'other';
    },
    ku: cp[1],
    kw: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    ky: cp[1],
    lag: function(n) {
      var s = String(n).split('.'), i = s[0];
      return (n == 0) ? 'zero'
          : ((i == 0
              || i == 1) && n != 0) ? 'one'
          : 'other';
    },
    lb: cp[1],
    lg: cp[1],
    lkt: cp[0],
    ln: cp[2],
    lo: cp[0],
    lt: function(n) {
      var s = String(n).split('.'), f = s[1] || '', t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1), n100 = t0 && s[0].slice(-2);
      return (n10 == 1 && (n100 < 11
              || n100 > 19)) ? 'one'
          : ((n10 >= 2 && n10 <= 9) && (n100 < 11
              || n100 > 19)) ? 'few'
          : (f != 0) ? 'many'
          : 'other';
    },
    lv: function(n) {
      var s = String(n).split('.'), f = s[1] || '', v = f.length,
          t0 = Number(s[0]) == n, n10 = t0 && s[0].slice(-1),
          n100 = t0 && s[0].slice(-2), f100 = f.slice(-2), f10 = f.slice(-1);
      return (t0 && n10 == 0 || (n100 >= 11 && n100 <= 19)
              || v == 2 && (f100 >= 11 && f100 <= 19)) ? 'zero'
          : (n10 == 1 && n100 != 11 || v == 2 && f10 == 1 && f100 != 11
              || v != 2 && f10 == 1) ? 'one'
          : 'other';
    },
    mas: cp[1],
    mg: cp[2],
    mgo: cp[1],
    mk: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i10 = i.slice(-1), f10 = f.slice(-1);
      return (v0 && i10 == 1
              || f10 == 1) ? 'one' : 'other';
    },
    ml: cp[1],
    mn: cp[1],
    mo: function(n) {
      var s = String(n).split('.'), v0 = !s[1], t0 = Number(s[0]) == n,
          n100 = t0 && s[0].slice(-2);
      return (n == 1 && v0) ? 'one'
          : (!v0 || n == 0
              || n != 1 && (n100 >= 1 && n100 <= 19)) ? 'few'
          : 'other';
    },
    mr: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    },
    ms: cp[0],
    mt: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n100 = t0 && s[0].slice(-2);
      return (n == 1) ? 'one'
          : (n == 0
              || (n100 >= 2 && n100 <= 10)) ? 'few'
          : ((n100 >= 11 && n100 <= 19)) ? 'many'
          : 'other';
    },
    my: cp[0],
    nah: cp[1],
    naq: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    nb: cp[1],
    nd: cp[1],
    ne: cp[1],
    nl: cp[3],
    nn: cp[1],
    nnh: cp[1],
    no: cp[1],
    nqo: cp[0],
    nr: cp[1],
    nso: cp[2],
    ny: cp[1],
    nyn: cp[1],
    om: cp[1],
    or: cp[1],
    os: cp[1],
    pa: cp[2],
    pap: cp[1],
    pl: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1], i10 = i.slice(-1),
          i100 = i.slice(-2);
      return (n == 1 && v0) ? 'one'
          : (v0 && (i10 >= 2 && i10 <= 4) && (i100 < 12
              || i100 > 14)) ? 'few'
          : (v0 && i != 1 && (i10 == 0 || i10 == 1)
              || v0 && (i10 >= 5 && i10 <= 9)
              || v0 && (i100 >= 12 && i100 <= 14)) ? 'many'
          : 'other';
    },
    prg: function(n) {
      var s = String(n).split('.'), f = s[1] || '', v = f.length,
          t0 = Number(s[0]) == n, n10 = t0 && s[0].slice(-1),
          n100 = t0 && s[0].slice(-2), f100 = f.slice(-2), f10 = f.slice(-1);
      return (t0 && n10 == 0 || (n100 >= 11 && n100 <= 19)
              || v == 2 && (f100 >= 11 && f100 <= 19)) ? 'zero'
          : (n10 == 1 && n100 != 11 || v == 2 && f10 == 1 && f100 != 11
              || v != 2 && f10 == 1) ? 'one'
          : 'other';
    },
    ps: cp[1],
    pt: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n;
      return ((t0 && n >= 0 && n <= 2) && n != 2) ? 'one' : 'other';
    },
    "pt-PT": cp[3],
    rm: cp[1],
    ro: function(n) {
      var s = String(n).split('.'), v0 = !s[1], t0 = Number(s[0]) == n,
          n100 = t0 && s[0].slice(-2);
      return (n == 1 && v0) ? 'one'
          : (!v0 || n == 0
              || n != 1 && (n100 >= 1 && n100 <= 19)) ? 'few'
          : 'other';
    },
    rof: cp[1],
    root: cp[0],
    ru: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1], i10 = i.slice(-1),
          i100 = i.slice(-2);
      return (v0 && i10 == 1 && i100 != 11) ? 'one'
          : (v0 && (i10 >= 2 && i10 <= 4) && (i100 < 12
              || i100 > 14)) ? 'few'
          : (v0 && i10 == 0 || v0 && (i10 >= 5 && i10 <= 9)
              || v0 && (i100 >= 11 && i100 <= 14)) ? 'many'
          : 'other';
    },
    rwk: cp[1],
    sah: cp[0],
    saq: cp[1],
    sdh: cp[1],
    se: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    seh: cp[1],
    ses: cp[0],
    sg: cp[0],
    sh: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i10 = i.slice(-1), i100 = i.slice(-2), f10 = f.slice(-1), f100 = f.slice(-2);
      return (v0 && i10 == 1 && i100 != 11
              || f10 == 1 && f100 != 11) ? 'one'
          : (v0 && (i10 >= 2 && i10 <= 4) && (i100 < 12 || i100 > 14)
              || (f10 >= 2 && f10 <= 4) && (f100 < 12
              || f100 > 14)) ? 'few'
          : 'other';
    },
    shi: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n;
      return (n >= 0 && n <= 1) ? 'one'
          : ((t0 && n >= 2 && n <= 10)) ? 'few'
          : 'other';
    },
    si: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '';
      return ((n == 0 || n == 1)
              || i == 0 && f == 1) ? 'one' : 'other';
    },
    sk: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1];
      return (n == 1 && v0) ? 'one'
          : ((i >= 2 && i <= 4) && v0) ? 'few'
          : (!v0) ? 'many'
          : 'other';
    },
    sl: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1], i100 = i.slice(-2);
      return (v0 && i100 == 1) ? 'one'
          : (v0 && i100 == 2) ? 'two'
          : (v0 && (i100 == 3 || i100 == 4)
              || !v0) ? 'few'
          : 'other';
    },
    sma: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    smi: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    smj: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    smn: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    sms: function(n) {
      return (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : 'other';
    },
    sn: cp[1],
    so: cp[1],
    sq: cp[1],
    sr: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i10 = i.slice(-1), i100 = i.slice(-2), f10 = f.slice(-1), f100 = f.slice(-2);
      return (v0 && i10 == 1 && i100 != 11
              || f10 == 1 && f100 != 11) ? 'one'
          : (v0 && (i10 >= 2 && i10 <= 4) && (i100 < 12 || i100 > 14)
              || (f10 >= 2 && f10 <= 4) && (f100 < 12
              || f100 > 14)) ? 'few'
          : 'other';
    },
    ss: cp[1],
    ssy: cp[1],
    st: cp[1],
    sv: cp[3],
    sw: cp[3],
    syr: cp[1],
    ta: cp[1],
    te: cp[1],
    teo: cp[1],
    th: cp[0],
    ti: cp[2],
    tig: cp[1],
    tk: cp[1],
    tl: function(n) {
      var s = String(n).split('.'), i = s[0], f = s[1] || '', v0 = !s[1],
          i10 = i.slice(-1), f10 = f.slice(-1);
      return (v0 && (i == 1 || i == 2 || i == 3)
              || v0 && i10 != 4 && i10 != 6 && i10 != 9
              || !v0 && f10 != 4 && f10 != 6 && f10 != 9) ? 'one' : 'other';
    },
    tn: cp[1],
    to: cp[0],
    tr: cp[1],
    ts: cp[1],
    tzm: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n;
      return ((n == 0 || n == 1)
              || (t0 && n >= 11 && n <= 99)) ? 'one' : 'other';
    },
    ug: cp[1],
    uk: function(n) {
      var s = String(n).split('.'), i = s[0], v0 = !s[1], i10 = i.slice(-1),
          i100 = i.slice(-2);
      return (v0 && i10 == 1 && i100 != 11) ? 'one'
          : (v0 && (i10 >= 2 && i10 <= 4) && (i100 < 12
              || i100 > 14)) ? 'few'
          : (v0 && i10 == 0 || v0 && (i10 >= 5 && i10 <= 9)
              || v0 && (i100 >= 11 && i100 <= 14)) ? 'many'
          : 'other';
    },
    ur: cp[3],
    uz: cp[1],
    ve: cp[1],
    vi: cp[0],
    vo: cp[1],
    vun: cp[1],
    wa: cp[2],
    wae: cp[1],
    wo: cp[0],
    xh: cp[1],
    xog: cp[1],
    yi: cp[3],
    yo: cp[0],
    zh: cp[0],
    zu: function(n) {
      return (n >= 0 && n <= 1) ? 'one' : 'other';
    }
  },
  ordinal: {
    af: cp[0],
    am: cp[0],
    ar: cp[0],
    as: function(n) {
      return ((n == 1 || n == 5 || n == 7 || n == 8 || n == 9
              || n == 10)) ? 'one'
          : ((n == 2
              || n == 3)) ? 'two'
          : (n == 4) ? 'few'
          : (n == 6) ? 'many'
          : 'other';
    },
    az: function(n) {
      var s = String(n).split('.'), i = s[0], i10 = i.slice(-1),
          i100 = i.slice(-2), i1000 = i.slice(-3);
      return ((i10 == 1 || i10 == 2 || i10 == 5 || i10 == 7 || i10 == 8)
              || (i100 == 20 || i100 == 50 || i100 == 70
              || i100 == 80)) ? 'one'
          : ((i10 == 3 || i10 == 4) || (i1000 == 100 || i1000 == 200
              || i1000 == 300 || i1000 == 400 || i1000 == 500 || i1000 == 600 || i1000 == 700
              || i1000 == 800
              || i1000 == 900)) ? 'few'
          : (i == 0 || i10 == 6 || (i100 == 40 || i100 == 60
              || i100 == 90)) ? 'many'
          : 'other';
    },
    be: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1), n100 = t0 && s[0].slice(-2);
      return ((n10 == 2
              || n10 == 3) && n100 != 12 && n100 != 13) ? 'few' : 'other';
    },
    bg: cp[0],
    bn: function(n) {
      return ((n == 1 || n == 5 || n == 7 || n == 8 || n == 9
              || n == 10)) ? 'one'
          : ((n == 2
              || n == 3)) ? 'two'
          : (n == 4) ? 'few'
          : (n == 6) ? 'many'
          : 'other';
    },
    bs: cp[0],
    ca: function(n) {
      return ((n == 1
              || n == 3)) ? 'one'
          : (n == 2) ? 'two'
          : (n == 4) ? 'few'
          : 'other';
    },
    ce: cp[0],
    cs: cp[0],
    cy: function(n) {
      return ((n == 0 || n == 7 || n == 8
              || n == 9)) ? 'zero'
          : (n == 1) ? 'one'
          : (n == 2) ? 'two'
          : ((n == 3
              || n == 4)) ? 'few'
          : ((n == 5
              || n == 6)) ? 'many'
          : 'other';
    },
    da: cp[0],
    de: cp[0],
    dsb: cp[0],
    el: cp[0],
    en: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1), n100 = t0 && s[0].slice(-2);
      return (n10 == 1 && n100 != 11) ? 'one'
          : (n10 == 2 && n100 != 12) ? 'two'
          : (n10 == 3 && n100 != 13) ? 'few'
          : 'other';
    },
    es: cp[0],
    et: cp[0],
    eu: cp[0],
    fa: cp[0],
    fi: cp[0],
    fil: cp[1],
    fr: cp[1],
    fy: cp[0],
    ga: cp[1],
    gl: cp[0],
    gu: function(n) {
      return (n == 1) ? 'one'
          : ((n == 2
              || n == 3)) ? 'two'
          : (n == 4) ? 'few'
          : (n == 6) ? 'many'
          : 'other';
    },
    he: cp[0],
    hi: function(n) {
      return (n == 1) ? 'one'
          : ((n == 2
              || n == 3)) ? 'two'
          : (n == 4) ? 'few'
          : (n == 6) ? 'many'
          : 'other';
    },
    hr: cp[0],
    hsb: cp[0],
    hu: function(n) {
      return ((n == 1
              || n == 5)) ? 'one' : 'other';
    },
    hy: cp[1],
    id: cp[0],
    in: cp[0],
    is: cp[0],
    it: function(n) {
      return ((n == 11 || n == 8 || n == 80
              || n == 800)) ? 'many' : 'other';
    },
    iw: cp[0],
    ja: cp[0],
    ka: function(n) {
      var s = String(n).split('.'), i = s[0], i100 = i.slice(-2);
      return (i == 1) ? 'one'
          : (i == 0 || ((i100 >= 2 && i100 <= 20) || i100 == 40 || i100 == 60
              || i100 == 80)) ? 'many'
          : 'other';
    },
    kk: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1);
      return (n10 == 6 || n10 == 9
              || t0 && n10 == 0 && n != 0) ? 'many' : 'other';
    },
    km: cp[0],
    kn: cp[0],
    ko: cp[0],
    ky: cp[0],
    lo: cp[1],
    lt: cp[0],
    lv: cp[0],
    mk: function(n) {
      var s = String(n).split('.'), i = s[0], i10 = i.slice(-1),
          i100 = i.slice(-2);
      return (i10 == 1 && i100 != 11) ? 'one'
          : (i10 == 2 && i100 != 12) ? 'two'
          : ((i10 == 7
              || i10 == 8) && i100 != 17 && i100 != 18) ? 'many'
          : 'other';
    },
    ml: cp[0],
    mn: cp[0],
    mo: cp[1],
    mr: function(n) {
      return (n == 1) ? 'one'
          : ((n == 2
              || n == 3)) ? 'two'
          : (n == 4) ? 'few'
          : 'other';
    },
    ms: cp[1],
    my: cp[0],
    nb: cp[0],
    ne: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n;
      return ((t0 && n >= 1 && n <= 4)) ? 'one' : 'other';
    },
    nl: cp[0],
    pa: cp[0],
    pl: cp[0],
    prg: cp[0],
    pt: cp[0],
    ro: cp[1],
    root: cp[0],
    ru: cp[0],
    sh: cp[0],
    si: cp[0],
    sk: cp[0],
    sl: cp[0],
    sq: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1), n100 = t0 && s[0].slice(-2);
      return (n == 1) ? 'one'
          : (n10 == 4 && n100 != 14) ? 'many'
          : 'other';
    },
    sr: cp[0],
    sv: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1), n100 = t0 && s[0].slice(-2);
      return ((n10 == 1
              || n10 == 2) && n100 != 11 && n100 != 12) ? 'one' : 'other';
    },
    sw: cp[0],
    ta: cp[0],
    te: cp[0],
    th: cp[0],
    tl: cp[1],
    tr: cp[0],
    uk: function(n) {
      var s = String(n).split('.'), t0 = Number(s[0]) == n,
          n10 = t0 && s[0].slice(-1), n100 = t0 && s[0].slice(-2);
      return (n10 == 3 && n100 != 13) ? 'few' : 'other';
    },
    ur: cp[0],
    uz: cp[0],
    vi: cp[1],
    zh: cp[0],
    zu: cp[0]
  }
}
})();
