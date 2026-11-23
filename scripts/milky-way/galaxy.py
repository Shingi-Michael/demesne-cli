import numpy as np
from PIL import Image, ImageFilter, ImageDraw
W,H=3090,800
def fbm(w,h,seed,octs=(6,12,24,48,96,192)):
    r=np.random.default_rng(seed); out=np.zeros((h,w)); amp=1
    for s in reversed(octs):
        a=r.random((h//s+3,w//s+3)).astype(np.float32)
        im=Image.fromarray((a*255).astype(np.uint8)).resize((w,h),Image.BICUBIC)
        out+=np.asarray(im,np.float32)/255*amp; amp*=0.55
    out-=out.min(); return out/out.max()
def blur(a,r): 
    return np.asarray(Image.fromarray((np.clip(a,0,1)*255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(r)),np.float32)/255
def render(dark=True):
    y,x=np.mgrid[0:H,0:W].astype(np.float32)
    n1=fbm(W,H,1); n2=fbm(W,H,2,(4,8,16,32,64)); n3=fbm(W,H,3,(48,96,192,384))
    # sky
    t=y/H
    if dark:
        img=np.stack([2+1.5*t,3+1.5*t,6+3*t],-1)
        img+=np.stack([40*n3**2.5,18*n3**2.5,70*n3**2.5],-1)*np.clip(1-x/W*0.6,0,1)[...,None]*0.16   # violet nebula haze, faint: space stays black
        teal=np.clip(n1-0.55,0,1)*np.exp(-((x-W*0.92)/(W*0.25))**2)*np.exp(-((y-H*0.15)/(H*0.5))**2)
        img+=np.stack([10*teal,60*teal,80*teal],-1)*0.5
    else:
        img=np.stack([150+90*t**1.2,162+72*t**1.2,222+22*t**1.2],-1)
    # galaxy, tilted disc
    cx,cy=W*0.19,H*0.37; rot=np.deg2rad(-20); inc=0.44; R=H*0.82
    dx,dy=x-cx,y-cy
    u=dx*np.cos(rot)+dy*np.sin(rot); v=(-dx*np.sin(rot)+dy*np.cos(rot))/inc
    r=np.hypot(u,v)/R; th=np.arctan2(v,u)
    pitch=np.tan(np.deg2rad(17))
    phase=2*(th-np.log(r+1e-3)/pitch)
    warp=(n1-0.5)*2.2
    arms=(0.5+0.5*np.cos(phase+warp))**2.2
    disc=np.exp(-r/0.33)
    armI=disc*(0.18+1.0*arms)*(0.55+0.9*n2)*np.clip(r/0.12,0,1)
    dust=(0.5+0.5*np.cos(phase+warp+1.25))**6*np.exp(-r/0.45)*(0.4+n2)*np.clip(r/0.1,0,1)
    armI=np.clip(armI*(1-0.75*np.clip(dust,0,1)),0,None)
    core=0.8*np.exp(-(r/0.07)**2)+0.35*np.exp(-(r/0.2)**2)
    halo=np.exp(-r/0.6)*0.10
    knots=blur((np.random.default_rng(9).random((H,W))>0.9993).astype(np.float32),2.2)*18*arms*disc*4
    g=dark and 1.0 or 0.6
    blue=np.array([125,150,255]); cream=np.array([255,236,205]); pink=np.array([255,130,170])
    if not dark: blue=np.array([255,255,255]); cream=np.array([255,246,230]); pink=np.array([255,220,225])
    add=blue*np.clip(armI,0,1.2)[...,None]*1.25*g+cream*np.clip(core,0,1.4)[...,None]*0.95*g+blue*halo[...,None]*g+pink*np.clip(knots,0,1)[...,None]*0.55*g
    if dark: img=img+add
    else: img=img+(255-img)*np.clip(add/255,0,1)*0.75
    img=np.clip(img,0,255)
    im=Image.fromarray(img.astype(np.uint8)).convert("RGBA"); d=ImageDraw.Draw(im,"RGBA")
    rs=np.random.default_rng(4)
    n=420 if dark else 60
    col=(232,237,255)
    for i in range(n):
        sx,sy=rs.random()*W,rs.random()*H*0.95; k=rs.random()
        rad,a=(1.1,105) if k<.7 else ((1.7,160) if k<.93 else (2.4,225))
        if not dark: a=int(a*0.8); 
        d.ellipse([sx-rad,sy-rad,sx+rad,sy+rad],fill=col+(a,))
    # disc stars
    for i in range(1500 if dark else 0):
        rr=rs.exponential(0.22); tt=rs.random()*6.283; uu,vv=rr*np.cos(tt)*R,rr*np.sin(tt)*R*inc
        sx=cx+uu*np.cos(rot)-vv*np.sin(rot); sy=cy+uu*np.sin(rot)+vv*np.cos(rot)
        d.ellipse([sx-0.9,sy-0.9,sx+0.9,sy+0.9],fill=(240,240,255,80))
    def glint(gx,gy,k,a):
        t=k*.13; d.polygon([(gx-k,gy),(gx-t,gy-t),(gx,gy-k),(gx+t,gy-t),(gx+k,gy),(gx+t,gy+t),(gx,gy+k),(gx-t,gy+t)],fill=col+(a,))
    for fx,fy in ([(.045,.62),(.4,.14),(.33,.66),(.93,.14)] if dark else [(.08,.3),(.9,.2)]): glint(W*fx,H*fy,15,235)
    a=np.asarray(im).astype(np.float32)
    
    return Image.fromarray(a.astype(np.uint8))
if __name__=="__main__":
    render(True).convert("RGB").save("sky-night.jpg",quality=90); render(False).convert("RGB").save("sky-dawn.jpg",quality=90); print("ok")
