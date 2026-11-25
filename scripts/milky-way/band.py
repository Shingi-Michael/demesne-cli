"""A full-window Milky Way: the band seen from inside the galaxy. Its light is made of stars;
dark rifts of dust cut it; a warm core; a black sky with crisp stars."""
import numpy as np, sys
from PIL import Image, ImageFilter
W=int(sys.argv[1]) if len(sys.argv)>1 else 3200; H=int(sys.argv[2]) if len(sys.argv)>2 else 2000
OUT=sys.argv[3] if len(sys.argv)>3 else "band.png"
ANG=float(sys.argv[4]) if len(sys.argv)>4 else 21; CY=float(sys.argv[5]) if len(sys.argv)>5 else 0.55
S=W/3200
def noise(beta,seed):
    r=np.random.default_rng(seed); f=np.fft.rfft2(r.standard_normal((H,W)))
    ky=np.fft.fftfreq(H)[:,None]; kx=np.fft.rfftfreq(W)[None,:]; k=np.sqrt(kx**2+ky**2); k[0,0]=1
    f/=k**beta; a=np.fft.irfft2(f,s=(H,W)); a-=a.mean(); return (a/a.std()).astype(np.float32)
from scipy.ndimage import gaussian_filter
def gblur(a,r): return gaussian_filter(a.astype(np.float32),r)
y,x=np.mgrid[0:H,0:W].astype(np.float32)
ang=np.deg2rad(ANG); cx,cy=W*0.5,H*CY
u=(x-cx)*np.cos(ang)-(y-cy)*np.sin(ang); v=(x-cx)*np.sin(ang)+(y-cy)*np.cos(ang)
v=v-0.00006*u**2/S
nb=noise(2.4,1); nm=noise(1.8,2); nf=noise(1.3,3)
warp=nb*H*0.035
d=(v+warp)/(H*0.092*(1+0.15*noise(2.6,4)))
band=np.exp(-0.5*d**2); halo=np.exp(-0.5*((v+warp)/(H*0.30))**2)
core=np.exp(-((u-W*0.16)/(W*0.20))**2)*np.exp(-0.5*((v+warp)/(H*0.14))**2)
along=0.62+0.38*np.exp(-((u-W*0.16)/(W*0.5))**2)
clouds=np.clip(0.6+0.4*nm+0.2*nf,0.05,None)
# dust: a great rift along the middle plus smooth dark lanes, soft edged
rift=np.exp(-0.5*((v+warp+H*0.02*noise(2.2,5))/(H*0.020))**2)*np.clip(0.35+0.75*noise(1.9,6),0,1)
lanes=np.clip((noise(2.0,7)-0.3)*1.2,0,1)**1.5*np.exp(-0.5*(d/1.3)**2)
fil=np.clip((1-np.abs(noise(1.6,8)))**6*1.6,0,1)*band
dust=np.clip(rift*0.8+lanes*0.5+fil*0.4,0,0.93)
glow=(band*along*clouds**1.5*0.55+halo*along*0.07+core*0.55)*(1-dust)
# star counts: dense where the band is bright and clear of dust
dens=np.clip((band*along*clouds+core*0.8)*(1-dust)**1.4,0,1)
acc=np.zeros((H,W,3),np.float32); rs=np.random.default_rng(11)
TEMP=np.array([[1.0,.80,.60],[1.0,.92,.82],[1.0,.98,.95],[.90,.94,1.0],[.76,.85,1.0]],np.float32)
def sprinkle(n,weight,lo,hi,alpha):
    px=rs.random(n)*W; py=rs.random(n)*H
    keep=rs.random(n)<weight[py.astype(int),px.astype(int)]
    px,py=px[keep],py[keep]; m=np.clip(lo*(rs.pareto(2.0,len(px))+1),0,hi)
    t=rs.choice(5,len(px),p=[.12,.22,.30,.24,.12])
    np.add.at(acc,(py.astype(int),px.astype(int)),(m[:,None]*TEMP[t]*alpha).astype(np.float32))
sprinkle(int(3.6e6*S*S),dens,0.05,0.30,1.0)      # unresolved: the band's grain
sprinkle(int(6.0e5*S*S),np.clip(dens*0.9+0.1,0,1),0.10,0.9,1.0)
sprinkle(int(5.5e4*S*S),np.ones((H,W),np.float32),0.16,1.3,1.0)
sprinkle(int(1.2e5*S*S),np.ones((H,W),np.float32),0.04,0.2,1.0)  # field stars everywhere
acc=np.stack([gblur(acc[...,i],0.6*S) for i in range(3)],-1)*2.1
warm=np.clip(core*1.4+band*0.15,0,1)
tint=np.stack([0.80+0.20*warm,0.82+0.08*warm,0.95-0.15*warm],-1)
img=np.ones((H,W,3),np.float32)*np.array([0.006,0.007,0.011],np.float32)
img+=glow[...,None]*tint*0.42
neb=np.clip(noise(2.0,9)-1.5,0,None)*band*(1-dust)
img+=neb[...,None]*np.array([0.06,0.012,0.03])
img+=acc*np.clip(1-dust*0.85,0.08,1)[...,None]
# bright stars with glow
big=np.zeros((H,W,3),np.float32); r=np.random.default_rng(21)
for i in range(int(340*S*S)):
    sx,sy=int(r.random()*W),int(r.random()*H); b=min(r.pareto(1.5)*0.35+0.35,7)
    big[sy,sx]+=TEMP[r.choice(5,p=[.15,.2,.3,.2,.15])]*b
img+=np.stack([gblur(big[...,i],1.0*S) for i in range(3)],-1)*7+np.stack([gblur(big[...,i],7*S) for i in range(3)],-1)*16
img=1-np.exp(-img*1.4)
img=np.clip(img,0,1)
out=(img*255+np.random.default_rng(3).random((H,W,1))*1.0).clip(0,255).astype(np.uint8)
Image.fromarray(out).save(OUT); print("ok",OUT,W,H)
