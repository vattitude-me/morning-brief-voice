# The static PWA, served the way a cloud static host serves it (Vercel in production).
# There is no build step: web/ is plain files.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY . /usr/share/nginx/html

# web/api/*.js are Vercel serverless functions, not static files. nginx cannot run
# them, so drop them rather than serve dead endpoints.
RUN rm -rf /usr/share/nginx/html/api

EXPOSE 80
