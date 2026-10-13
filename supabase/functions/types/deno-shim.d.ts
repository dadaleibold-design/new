/* ============================================================
 * supabase/functions/types/deno-shim.d.ts
 * ------------------------------------------------------------
 * تعريفات أنواع مختصرة تسمح بفحص الدوال بـ `tsc` محلياً (بلا Deno مثبَّت).
 * على Supabase Deno يوفّر هذه الأنواع أصلاً — لا نحتاجها وقت التشغيل،
 * وهي للتحقّق من الأنواع فقط (`npm run typecheck`).
 * ============================================================ */

declare namespace Deno {
  namespace env {
    function get(key: string): string | undefined;
  }
  function serve(handler: (request: Request) => Response | Promise<Response>): void;
}

/* --- وحدات esm.sh البعيدة: سطح API المستخدَم فعلياً في الدوال --- */

declare module "https://esm.sh/@supabase/supabase-js@2" {
  /**
   * عميل supabase-js يبني سلاسل استعلام ديناميكية (select/eq/in/or/update…)
   * ويُرجع صفوفاً غير مُنمَّطة من قاعدة البيانات. نمذجته بدقة ستُنتج أخطاءً
   * عن المكتبة لا عن كودنا، لذا نكتفي هنا — وفحص الأنواع يبقى فعّالاً على
   * منطق الدالة نفسه (المتغيرات، الواجهات، الدوال، القيم الفارغة).
   */
  // deno-lint-ignore no-explicit-any
  export function createClient(url: string, key: string, options?: Record<string, unknown>): any;
}

declare module "https://esm.sh/jose@5.10.0" {
  export function importPKCS8(pkcs8: string, alg: string): Promise<CryptoKey>;
  export class SignJWT {
    constructor(payload: Record<string, unknown>);
    setProtectedHeader(header: Record<string, unknown>): this;
    setIssuer(issuer: string): this;
    setAudience(audience?: string): this;
    setSubject(subject: string): this;
    setIssuedAt(value?: number): this;
    setExpirationTime(value: number | string): this;
    sign(key: CryptoKey): Promise<string>;
  }
}

declare module "https://esm.sh/agora-access-token@2.0.0" {
  export const RtcRole: { PUBLISHER: number; SUBSCRIBER: number };
  export const RtcTokenBuilder: {
    buildTokenWithUid(
      appId: string,
      appCertificate: string,
      channelName: string,
      uid: number,
      role: number,
      privilegeExpiredTs: number
    ): string;
  };
}
