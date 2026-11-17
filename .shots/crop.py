from PIL import Image
im = Image.open(r"C:/AI/web-game/.shots/12-render2.png")
c = im.crop((205,145,805,745)).resize((900,900), Image.LANCZOS)
c.save(r"C:/AI/web-game/.shots/13-crop.png")
print("ok", c.size)
