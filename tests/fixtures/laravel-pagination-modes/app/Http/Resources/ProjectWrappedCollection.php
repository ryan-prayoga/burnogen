<?php

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\ResourceCollection;

class ProjectWrappedCollection extends ResourceCollection
{
    public $collects = ProjectWrappedResource::class;

    public function toArray(Request $request): array
    {
        return [
            'items' => $this->collection,
            'pagination' => [
                'source' => 'wrapped_collection',
            ],
        ];
    }
}
