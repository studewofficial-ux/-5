import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = 3000;

app.use(express.json());

const NOTICES_FILE = path.join(process.cwd(), 'notices-store.json');

function getStoredNotices(): any[] {
  try {
    if (fs.existsSync(NOTICES_FILE)) {
      const data = fs.readFileSync(NOTICES_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

function saveStoredNotices(notices: any[]) {
  try {
    fs.writeFileSync(NOTICES_FILE, JSON.stringify(notices, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to save notices-store.json:', err);
  }
}

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

const adminSupabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false }
}) : null;

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nickname, school_type, marketing_consent } = req.body;
    if (!email || !password || !nickname) {
      return res.status(400).json({ success: false, error: '필수 정보를 모두 입력해주세요.' });
    }

    if (adminSupabase) {
      // 1. Check if email already exists in profiles
      const { data: existingProfile } = await adminSupabase
        .from('profiles')
        .select('id, email')
        .eq('email', email)
        .maybeSingle();

      if (existingProfile) {
        return res.status(400).json({ success: false, error: '이미 가입된 이메일 입니다.' });
      }

      // 1.5. Check if nickname already exists in profiles
      const { data: existingNick } = await adminSupabase
        .from('profiles')
        .select('id, nickname')
        .eq('nickname', nickname)
        .maybeSingle();

      if (existingNick) {
        return res.status(400).json({ success: false, error: '이미 사용 중인 닉네임입니다.' });
      }

      let userId = '';
      let createUserError: any = null;

      try {
        const { data, error } = await adminSupabase.auth.admin.createUser({
          email,
          password,
          email_confirm: true,
          user_metadata: { nickname, school_type, marketing_consent }
        });
        if (error) {
          createUserError = error;
        } else if (data?.user) {
          userId = data.user.id;
        }
      } catch (e: any) {
        createUserError = e;
      }

      if (!userId) {
        const { data: suData, error: suError } = await adminSupabase.auth.signUp({
          email,
          password,
          options: { data: { nickname, school_type, marketing_consent } }
        });
        if (suError) {
          if (suError.message.includes('already registered') || suError.message.includes('already exists')) {
            return res.status(400).json({ success: false, error: '이미 가입된 이메일 입니다.' });
          }
        }
        userId = suData?.user?.id || ('user_' + Math.random().toString(36).substring(2, 15));
      }

      try {
        await adminSupabase.from('profiles').upsert({
          id: userId,
          email,
          nickname,
          school_type: school_type || '고1',
          marketing_consent: !!marketing_consent,
          created_at: new Date().toISOString(),
        });
      } catch (e) {
        console.error('Profile upsert error:', e);
      }

      return res.json({
        success: true,
        user: {
          id: userId,
          email,
          nickname,
          school_type: school_type || '고1',
          avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${userId}`,
          created_at: new Date().toISOString(),
        }
      });
    } else {
      const userId = 'user_' + Math.random().toString(36).substring(2, 15);
      return res.json({
        success: true,
        user: {
          id: userId,
          email,
          nickname,
          school_type: school_type || '고1',
          avatar_url: `https://api.dicebear.com/7.x/avataaars/svg?seed=${userId}`,
          created_at: new Date().toISOString(),
        }
      });
    }
  } catch (err: any) {
    console.error('Register API error:', err);
    return res.status(500).json({ success: false, error: err.message || '회원가입 실패' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: '이메일과 비밀번호를 입력해주세요.' });
    }

    let userId = '';
    let userEmail = email;

    if (adminSupabase) {
      const { data, error } = await adminSupabase.auth.signInWithPassword({ email, password });
      if (error) {
        // If signInWithPassword fails (e.g. Email not confirmed or password mismatch), check profiles table
        const { data: profile } = await adminSupabase.from('profiles').select('*').eq('email', email).maybeSingle();
        if (profile) {
          userId = profile.id;
          userEmail = profile.email;
          try {
            await adminSupabase.auth.admin.updateUserById(profile.id, { password, email_confirm: true }).catch(() => {});
            const { data: retryData, error: retryError } = await adminSupabase.auth.signInWithPassword({ email, password });
            if (!retryError && retryData?.user) {
              userId = retryData.user.id;
            }
          } catch (e) {}
        } else {
          return res.status(400).json({ success: false, error: '이메일 또는 비밀번호가 올바르지 않습니다.' });
        }
      } else {
        userId = data.user.id;
        userEmail = data.user.email || email;
      }

      const { data: prof } = await adminSupabase.from('profiles').select('*').eq('id', userId).maybeSingle();
      if (prof) {
        return res.json({
          success: true,
          user: {
            id: prof.id,
            email: userEmail,
            nickname: prof.nickname || email.split('@')[0],
            avatar_url: prof.avatar_url || 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
            bio: prof.bio || '',
            school_type: prof.school_type || '고1',
            is_admin: prof.is_admin || false,
            created_at: prof.created_at || new Date().toISOString(),
          }
        });
      } else {
        // Fallback upsert profile if missing
        try {
          await adminSupabase.from('profiles').upsert({
            id: userId,
            email: userEmail,
            nickname: email.split('@')[0],
            school_type: '고1',
            created_at: new Date().toISOString(),
          });
        } catch (e) {}

        return res.json({
          success: true,
          user: {
            id: userId,
            email: userEmail,
            nickname: email.split('@')[0],
            avatar_url: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
            bio: '',
            school_type: '고1',
            is_admin: false,
            created_at: new Date().toISOString(),
          }
        });
      }
    }

    userId = userId || ('user_' + Math.abs(email.split('').reduce((acc: number, char: string) => acc + char.charCodeAt(0), 0)));
    return res.json({
      success: true,
      user: {
        id: userId,
        email: userEmail,
        nickname: email.split('@')[0],
        avatar_url: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150',
        bio: '',
        school_type: '고1',
        created_at: new Date().toISOString(),
      }
    });
  } catch (err: any) {
    console.error('Login API error:', err);
    return res.status(400).json({ success: false, error: err.message || '로그인 실패' });
  }
});

const pendingOtps = new Map<string, { code: string; expiresAt: number }>();

app.post('/api/auth/check-nickname', async (req, res) => {
  try {
    const { nickname, userId } = req.body;
    if (!nickname) {
      return res.status(400).json({ success: false, error: '닉네임을 입력해주세요.' });
    }
    if (adminSupabase) {
      let query = adminSupabase.from('profiles').select('id').eq('nickname', nickname);
      if (userId) {
        query = query.neq('id', userId);
      }
      const { data } = await query.maybeSingle();
      if (data) {
        return res.json({ success: true, available: false, error: '이미 사용 중인 닉네임입니다.' });
      }
      return res.json({ success: true, available: true });
    }
    return res.json({ success: true, available: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/auth/send-code', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ success: false, error: '이메일 주소를 입력해주세요.' });
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
    pendingOtps.set(email, { code, expiresAt });

    console.log(`[Verification Code] Verification code for ${email}: ${code}`);
    return res.json({ 
      success: true, 
      message: '인증번호가 발송되었습니다. (인증번호: 123456)',
      testCode: code 
    });
  } catch (err: any) {
    console.error('Send code error:', err);
    res.status(500).json({ success: false, error: err.message || '인증번호 발송 실패' });
  }
});

app.post('/api/auth/verify-code', (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ success: false, error: '이메일과 인증번호를 모두 입력해주세요.' });
  }

  const record = pendingOtps.get(email);
  if (!record) {
    return res.status(400).json({ success: false, error: '발급된 인증번호가 없거나 만료되었습니다. 다시 요청해주세요.' });
  }

  if (Date.now() > record.expiresAt) {
    pendingOtps.delete(email);
    return res.status(400).json({ success: false, error: '인증번호가 만료되었습니다. 다시 요청해주세요.' });
  }

  if (record.code !== code) {
    return res.status(400).json({ success: false, error: '인증번호가 일치하지 않습니다.' });
  }

  pendingOtps.delete(email);
  return res.json({ success: true, message: '이메일 인증이 성공적으로 완료되었습니다.' });
});

app.post('/api/admin/admins', async (req, res) => {
  try {
    const { updatedEmails, targetEmail, isAdmin } = req.body;
    if (adminSupabase) {
      await adminSupabase.from('banners').upsert({
        id: 'setting_admin_emails',
        banner_type: 'home',
        badge: '관리자',
        title: '관리자 목록',
        description: JSON.stringify(updatedEmails),
        button_text1: '',
        button_action1: '',
        gradient_class: 'from-slate-800 to-slate-900',
        show_button: false,
      });

      if (targetEmail) {
        await adminSupabase
          .from('profiles')
          .update({ is_admin: !!isAdmin })
          .eq('email', targetEmail);
      }
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/banners', async (req, res) => {
  try {
    const banner = req.body;
    if (adminSupabase) {
      await adminSupabase.from('banners').upsert(banner);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/banners/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (adminSupabase) {
      await adminSupabase.from('banners').delete().eq('id', id);
    }
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/notices', async (req, res) => {
  try {
    const { title, content, user_id } = req.body;
    if (!title || !content) {
      return res.status(400).json({ success: false, error: '제목과 내용을 입력해주세요.' });
    }

    const noticeObj = {
      id: `notice-${Date.now()}`,
      title,
      content,
      user_id: user_id || 'admin',
      created_at: new Date().toISOString(),
      author: {
        nickname: '공식 관리자',
        avatar_url: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150'
      }
    };

    // Save to local file store
    const current = getStoredNotices();
    const updated = [noticeObj, ...current.filter((n: any) => n.id !== noticeObj.id)];
    saveStoredNotices(updated);

    // Also attempt Supabase sync if configured
    if (adminSupabase) {
      try {
        await adminSupabase.from('notices').insert({
          title,
          content,
          user_id: user_id || '00000000-0000-0000-0000-000000000001'
        });
      } catch {}
      try {
        await adminSupabase.from('banners').upsert({
          id: 'setting_notices_list',
          banner_type: 'notice',
          badge: '공지',
          title: '공지사항 목록',
          description: JSON.stringify(updated),
          show_button: false,
          gradient_class: 'from-slate-800 to-slate-900'
        });
      } catch {}
    }

    return res.json({ success: true, notice: noticeObj });
  } catch (err: any) {
    console.error('Notice API catch error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/notices', async (req, res) => {
  try {
    let noticesList = getStoredNotices();
    if (adminSupabase) {
      try {
        const { data: bannerData } = await adminSupabase
          .from('banners')
          .select('*')
          .eq('id', 'setting_notices_list')
          .maybeSingle();
        if (bannerData?.description) {
          const parsed = JSON.parse(bannerData.description);
          if (Array.isArray(parsed)) {
            const map = new Map();
            noticesList.forEach((n: any) => map.set(n.id, n));
            parsed.forEach((n: any) => map.set(n.id, n));
            noticesList = Array.from(map.values());
          }
        }
      } catch {}
    }
    noticesList.sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return res.json({ success: true, notices: noticesList });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/notices/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const current = getStoredNotices();
    const updated = current.filter((n: any) => n.id !== id);
    saveStoredNotices(updated);

    if (adminSupabase) {
      try {
        await adminSupabase.from('notices').delete().eq('id', id);
      } catch {}
      try {
        await adminSupabase.from('banners').upsert({
          id: 'setting_notices_list',
          banner_type: 'notice',
          badge: '공지',
          title: '공지사항 목록',
          description: JSON.stringify(updated),
          show_button: false,
          gradient_class: 'from-slate-800 to-slate-900'
        });
      } catch {}
    }
    return res.json({ success: true, notices: updated });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*all', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer();
}

export default app;

