import React from 'react';
import WordEditor from './WordEditor.jsx';

export function OfficePane({ classic }) {
  return classic;
}

export default function WordPane(props) {
  const { id: _id, ...editorProps } = props;
  return <WordEditor {...editorProps} />;
}
