const mark =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill='%23333' d='M0 0h1v1z'/%3E%3C/svg%3E\")";

export default function Page() {
  return <main data-mark={mark}>Agent Studio</main>;
}
